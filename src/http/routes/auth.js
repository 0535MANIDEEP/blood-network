import { Router } from 'express';

import {
  registerAccount,
  login,
  logout,
  requestPasswordReset,
  completePasswordReset,
} from '../../auth/service.js';
import { sessionCookie, clearSessionCookie } from '../../auth/session.js';
import { requireAuth, validate, schemas } from '../middleware.js';
import { badRequest } from '../errors.js';
import { assertNoClinicalClaim, requiredDisclaimer } from '../../policy/boundary.js';

/**
 * Account endpoints.
 *
 * The response shape is identical whether or not an account exists, on every
 * endpoint that could reveal that. Registration, login and password reset all
 * fail the same way for a wrong answer and for an unknown phone, because each of
 * them is otherwise a way to enumerate who is registered in a system where being
 * a registered donor is itself information.
 */

export function authRoutes({ db, throttle, secureCookies = true, passwordCost, expiry } = {}) {
  const router = Router();

  router.post('/register', validate(schemas.register), async (req, res, next) => {
    try {
      const result = await registerAccount(db, req.body, { throttle, passwordCost });

      const session = await login(
        db,
        { phone: req.body.phone, password: req.body.password },
        { throttle, expiry },
      );

      res.set('Set-Cookie', sessionCookie(session.token, { secure: secureCookies }));
      res.status(201).json({
        user: result.user,
        donorId: result.donorId,
        bankId: result.bankId,
        // Said plainly rather than buried. A bank that has just signed up cannot
        // supply blood until a coordinator checks its licence, and finding that
        // out by trying to reserve and being refused is a bad first experience.
        pendingVerification: result.pendingVerification,
        notice: result.pendingVerification
          ? 'Your bank is listed. A coordinator must verify its licence before it can supply blood.'
          : undefined,
        disclaimer: requiredDisclaimer(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', validate(schemas.login), async (req, res, next) => {
    try {
      const result = await login(
        db,
        {
          phone: req.body.phone,
          password: req.body.password,
          source: req.ip,
          userAgent: req.headers['user-agent'],
        },
        { throttle, expiry },
      );

      res.set('Set-Cookie', sessionCookie(result.token, { secure: secureCookies }));
      res.json({
        user: result.user,
        expiresAt: result.expiresAt,
        // Reported so a coordinator dashboard can flag a login attempt from an
        // address that has failed against many accounts. Reported, not acted on,
        // because a hospital or a college behind one NAT looks identical.
        sourceRisk: result.risk.level,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const { readSessionCookie } = await import('../../auth/session.js');
      const token = readSessionCookie(req.headers.cookie);
      const result = await logout(db, token);
      res.set('Set-Cookie', clearSessionCookie());
      res.json({ ...result });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({
      user: req.user,
      // Surfaced so the UI can explain a session that has outlived the policy,
      // rather than the user just being logged out for no stated reason.
      sessionSuspectedAge: req.session?.suspiciousAge ?? false,
    });
  });

  /**
   * Always the same response. A different answer for an unknown number turns
   * this into a membership directory, which for a donor registry is a list of
   * who is prepared to give blood and where.
   */
  router.post('/reset-request', validate(schemas.resetRequest), async (req, res, next) => {
    try {
      const result = await requestPasswordReset(db, {
        phone: req.body.phone,
        source: req.ip,
        // No delivery channel is wired in this build. The token is never put in
        // the response, because returning it would make this endpoint a way to
        // take over any account that exists.
        deliver: undefined,
      });
      res.json({
        accepted: true,
        message: 'If that number has an account, a reset link is on its way.',
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/reset-complete', validate(schemas.resetComplete), async (req, res, next) => {
    try {
      await completePasswordReset(db, req.body, { passwordCost });
      res.set('Set-Cookie', clearSessionCookie());
      res.json({
        passwordChanged: true,
        sessionsRevoked: true,
        message: 'Password changed. Every other device has been signed out.',
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * A display name, a hospital name and a reply body all end up on somebody's
   * screen during an emergency. The clinical claim filter runs on them, because
   * this project ranks compatibility and does not certify blood, and a user
   * supplied string is the one place that distinction can quietly disappear.
   */
  router.post('/echo-check', requireAuth, validate(schemas.reply), (req, res, next) => {
    try {
      assertNoClinicalClaim(req.body.body);
      res.json({ ok: true });
    } catch (err) {
      next(badRequest(err.message));
    }
  });

  return router;
}

# Publish: blood-network backend to GitHub as verifiable evidence

## Definition of done

The repository is on `0535MANIDEEP` at a public URL, the README tells the truth
about what the project is and is not, CI runs the full test suite green, and
every command documented in the README has been executed and shown to work.

## Checklist

- [x] 1. Verify git identity matches the portfolio repos
- [x] 2. Scan tracked files for real secrets
- [ ] 3. Write README: what it is, what it is NOT, how to run, what is verified, what is blocked
- [ ] 4. Write .env.example with every variable the code actually reads
- [ ] 5. Add GitHub Actions CI running the real test suite
- [ ] 6. Verify README commands actually work, from a clean clone
- [ ] 7. Create the repo under 0535MANIDEEP and push
- [ ] 8. Verify the push with `git ls-remote` and an HTTP probe of the public URL
- [ ] 9. Verify CI is green on the remote
- [ ] 10. Reconcile the portfolio's project entry with what the repo now contains

## Non-negotiable constraints

- No claim in the README that the code does not actually back.
- The regulatory policy is unreviewed. The README must say so plainly, and
  `reviewed: false` stays.
- No real patient data, no real banks, no real notification recipients.
- No demo video, no mockup presented as a working thing.

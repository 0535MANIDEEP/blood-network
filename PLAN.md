# Publish: blood-network backend, and repair the portfolio

## Definition of done

The backend is on `0535MANIDEEP` at a public URL with a README that tells the
truth, CI running the suite green, every documented command verified. The
portfolio renders instead of being a blank page, and its project entry points at
a repository that exists.

## Checklist

- [x] 1. Git identity matches the portfolio repos
- [x] 2. No real secrets in tracked files
- [x] 3. README: what it is, what it is NOT, how to run, what is verified, what is blocked
- [x] 4. `.env.example` covering every variable the code reads
- [x] 5. CI running the real suite, plus guards on `.pgdata`, secrets and the policy flag
- [x] 6. Every README command executed from a clean copy
- [x] 7. Repo created and pushed, verified with `git ls-remote` and raw HTTP probes
- [x] 8. CI green on the remote, read from the run log
- [x] 9. Portfolio renders in a real browser, zero console errors
- [x] 10. Portfolio project entry added, every URL fetched and confirmed 200

## What the checklist did not predict

Item 9 was supposed to be a formality. The deployed site was a blank white
page, and had been for long enough that a Lighthouse report of 1.0 across the
board was being read as evidence of quality. A blank page scores 1.0 across the
board. The perfect report was the symptom.

Cause: `Projects.jsx` rendered `<ArrowDown>` while importing only
`{ ArrowUpRight }`. One missing name in one import statement, and the whole
React tree died on first render.

Two gates now exist that did not before, and both were verified by putting the
bug back and confirming the suite exits 1:

- a render test that mounts the app through `react-dom/server` and asserts a
  substantial document with every section present
- a static check that every PascalCase element a component renders is bound in
  that same file, which is the direction that catches this class. An
  import-versus-export check passes happily, because `ArrowDown` is a real
  export of `icons.jsx`; the file rendering it simply never imported it.

A post-deploy job now also fetches the live URL and checks the document and its
assets, because a green build says nothing about what Pages served.

## Non-negotiable constraints, all held

- No claim in the README the code does not back.
- `regulatory.js` stays `reviewed: false`. CI fails the build if anyone flips it
  without a named reviewer.
- No real patient data, no real banks, no real notification recipients.
- The portfolio's blood card states what the project is not, and a test asserts
  that text stays on the card.

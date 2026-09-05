# Contributing

Development follows GitHub Flow.

1. Start from an up-to-date `main` branch.
2. Create a short-lived branch named `feature/*`, `fix/*`, `docs/*`, or `chore/*`.
3. Keep each pull request focused on one product change.
4. Include verification notes and screenshots for visible UI changes.
5. Require the automated checks and one review before squash-merging.
6. Never push feature work or release commits directly to `main`.

## Local checks

Run `npm ci`, `npm run lint`, and `npm run build` before opening a pull request. Desktop packaging is performed by the release workflow for version tags.

## Releases

Use semantic versions. Merge approved work to `main`, update the changelog, then create an annotated `vX.Y.Z` tag. The release workflow builds the Windows desktop artifact and creates a draft GitHub Release for final review.

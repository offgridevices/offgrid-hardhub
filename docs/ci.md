# CI and automatic deploys

Every pull request is tested and reviewed. Merging it to `main` tests it once
more and then puts it live at hardhub.offgridevices.com, with the database
changes, without anyone running a command. The same pattern as the other
`offgridevices` repositories (Blacksmith runners, a Claude review that tests in
its own sandbox), set up for what HardHub is: a Worker, a web app, a D1
database and a KiCad engine container.

## What runs when

```
pull request opened or pushed to
  └─ Claude Code Review (.github/workflows/claude-code-review.yml)
       ├─ ci / quality   types, unit tests, migrations on D1, web build        ~4 min
       ├─ ci / e2e       engine tests (real KiCad), then ./hardhub test        ~15 min
       └─ review         Claude reads it, runs tests of its own, comments      ~10-25 min
                         (only once both ci jobs are green)

merge to main
  └─ CI (.github/workflows/ci.yml)
       ├─ quality, e2e   the same checks, on the merged code
       └─ deploy         only if both are green:
            1. note the live version (the one to go back to)
            2. database migrations (D1, US)
            3. web app, Worker, Durable Objects, KiCad engine container
            4. live check: API, page and engine, three clean rounds
               └─ still failing after 8 minutes → roll back, and the run goes red

@claude in a pull request comment
  └─ Claude Mention (.github/workflows/claude-mention.yml)   answers in the thread
```

- **ci / quality**: `pnpm -r typecheck`, `pnpm -r test` (web, API, protocol),
  `wrangler d1 migrations apply --local` (every migration, on D1 itself), and
  the web build with the production settings.
- **ci / e2e**: `./scripts/engine-tests.sh` (the engine's tests in its own
  image, with KiCad and Freerouting), then `./hardhub test`: the whole stack in
  Docker with a scripted stand-in for the AI, a browser designing a board,
  building it in KiCad, editing it by hand, checking and ordering it, and every
  screen at phone, tablet and desktop in light and dark. Its screenshots are
  attached to the run as `e2e-shots` and handed to the reviewer.
- **review**: Claude (Opus) reads the diff, the codebase and CI's logs and
  screenshots. It can run the tests, the engine's tests, the end-to-end test
  and throwaway tests it writes itself. It comments on lines and ends with one
  **Verdict** line. Drafts, Dependabot and pull requests from forks get CI but
  no review. If Claude posts nothing, the check goes red: green always means a
  review happened.
- **deploy**: `apps/api/scripts/deploy.mjs`, the same script as
  `./hardhub deploy`, signed in with an API token instead of a browser.

A failing check stops the pull request; nothing is deployed until it is green
and merged. A deploy is never cancelled halfway. A merge that lands while one is
deploying waits, then deploys; if several land meanwhile, only the newest
waits (it contains the others).

## Database changes

Migrations live in `apps/api/migrations/` and run on every deploy, before the
new code goes up. A rollback puts the previous code back but **does not undo a
migration**, so every migration has to keep the version before it working:

- fine: a new table, a new column with a default or that may be empty, a new index
- not fine in one step: renaming or dropping a column or table the live code
  reads, a new NOT NULL column without a default

To rename or drop: add the new thing and ship code that uses it; drop the old
one in a later pull request. The reviewer is told to flag this.

## What the automatic rollback covers

It puts the previous Worker version back: the API, the web app (its files go
with the Worker version) and the Worker's secrets. It does not undo a migration
(above), and it is not documented to bring back the previous engine container
image, which `wrangler deploy` rolls out on its own schedule.

So the dependable way back from anything, engine included, is the same road
forward: revert the pull request on GitHub and merge the revert. CI tests it
and deploys the old code like any other change. For the Worker alone, in a
hurry:

```bash
cd apps/api && pnpm exec wrangler deployments list --env production
cd apps/api && pnpm exec wrangler rollback <version-id> --env production
```

## One-time setup

```bash
./scripts/setup-ci-secrets.sh
```

It walks through the three repository secrets below: opens Cloudflare's token
page with the clicks to make, checks the token can do each part of the deploy,
runs `claude setup-token`, and saves each value to GitHub without showing or
storing it. By hand instead (Settings → Secrets and variables → Actions):

| Secret | What it is | How to make it |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | the review's and @claude's sign-in, billed to the Claude subscription | `claude setup-token` in a terminal, copy the token it prints |
| `CLOUDFLARE_API_TOKEN` | lets the deploy job deploy | Cloudflare dashboard → My Profile → API Tokens → Create Token (permissions below) |
| `CLOUDFLARE_ACCOUNT_ID` | which Cloudflare account | the dashboard's Workers overview, or `wrangler whoami` |

Set each with `gh secret set <NAME> --repo offgridevices/offgrid-hardhub`
(it asks for the value, so it never lands in your shell history).

### The Cloudflare API token's permissions

Start from the **Edit Cloudflare Workers** template, then add **D1 · Edit** and
**Containers · Edit**. Under "Account Resources" pick only OffGrid's account,
and under "Zone Resources" only `offgridevices.com`.

| Scope | Permission | Access | Used for |
|---|---|---|---|
| Account | Workers Scripts | Edit | deploy, secrets, versions, rollback (in the template) |
| Account | Workers R2 Storage | Edit | checking the file bucket exists (in the template) |
| Account | Account Settings | Read | finding the account (in the template) |
| Account | **D1** | **Edit** | database migrations (add) |
| Account | **Containers** | **Edit** | pushing and rolling out the KiCad engine image (add) |
| Zone | Workers Routes | Edit | the `hardhub.offgridevices.com` custom domain (in the template) |
| User | User Details, Memberships | Read | `wrangler whoami` (in the template) |

The template's Workers KV, Workers Tail and Pages permissions are not used and
can be removed. Cloudflare's documentation does not name the container
permission for certain; if the deploy step fails with a 403 or "Authentication
error" while pushing the engine image, add **Cloudchamber · Edit** (the older
name for the same service). Moving the site to a new domain would also need
**Zone · DNS · Edit**.

### Protecting main

Since merging deploys, `main` is protected by a branch ruleset (Settings →
Rules → Rulesets): changes arrive only through a pull request, and only once
`ci / quality` and `ci / e2e` are green. No app or bot may bypass it. That
last part matters: the reviewer runs code it writes, with tokens in reach, so
the ruleset (not the reviewer's tool list) is what keeps a bad push from
reaching production. The review is advisory (it comments and gives a verdict);
requiring it too would block a pull request that changes the review workflow
itself, which the reviewer cannot run on (see below).

### Pull requests from forks

This repository is public. Settings → Actions → General → "Require approval
for all external contributors", so a stranger's pull request does not spend
the org's Blacksmith minutes until someone approves the run. Forks never get
the paid review or any secret either way.

## When the reviewer cannot run

GitHub will not run a changed copy of the workflow that holds the review's
secret, so a pull request that edits `claude-code-review.yml` cannot be
machine-reviewed. The review job says so in a comment and goes red; CI still
runs in full. Keep workflow changes in their own small pull request, reviewed
by a person.

## Cost

Blacksmith's free plan is 3,000 2-vCPU minutes a month across the org. A push
to a pull request uses about 20 minutes of CI plus the review's runner time; a
merge about 30 with the deploy. The KiCad engine image is cached on a
Blacksmith disk between runs (`setup-docker-builder`), which keeps the e2e and
deploy jobs from rebuilding KiCad each time.

# The website's database

Riosoma's public website is published from a Riosoma database.  This folder makes that database and
fills it through the app's own API, the way `../demo` builds the demo.  It makes one database,
**Riosoma**, with four tables:

- **Features**: what the site says Riosoma does, from `content.json`, in the order the pages show
  it, with a grid in that order and a list that files the features under their area.
- **Questions**: the questions the site answers, from `content.json`, in the order the page asks
  them.
- **Themes**: every theme in the repository's `themes/` folder, read when the seed runs, with the
  number of color schemes each one lists.
- **Data sources**: every kind of source the product connects to, read when the seed runs from the
  catalog behind the "Sync from a data source" picker, in that picker's four groups.

Nothing here builds the pages or publishes the site.  That follows once the site's own blocks exist.

Every step looks for what it would make before making it, and a record is matched by the field that
names it, so running the seed again adds nothing and leaves what a person edited alone.

Run it from the repository root, after `pnpm turbo run build`:

```
pnpm --filter @riosoma/e2e exec playwright test --config website/playwright.config.ts
```

That starts a fresh local stack, builds the database, runs the seed a second time to check that
nothing was added or changed, and checks the record counts against `content.json`, the themes
folder, and the picker's catalog.

To fill an instance that is already running instead of a local stack, name it and its owner:
`RIOSOMA_WEBSITE_BASE_URL`, `RIOSOMA_WEBSITE_EMAIL`, and `RIOSOMA_WEBSITE_PASSWORD`.  The password
is only ever typed into the sign-in form; nothing prints it and nothing writes it to a file, and the
checks that would write a record skip themselves against an instance a person is running.

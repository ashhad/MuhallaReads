# Working on MuhallaReads

- Commit and push directly to `main` (the owner's standing instruction). Don't create other branches or pull requests unless asked.
- Run `npm test` before pushing; all tests must pass.
- Privacy is a core rule: members' phone numbers must never reach the website or another member, except a number its owner explicitly shared via `share`.
- The app runs on an Oracle Always Free VM, deployed with `deploy/oracle/setup.sh`. Keep it cheap: no paid services, and WhatsApp messages should stay within the free window or the template budget (see `src/notifier.js`).

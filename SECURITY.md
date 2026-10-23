# Security

MohallaReads is a small, volunteer-run neighbourhood library. It stores members' names, rough
locations (building or locality) and WhatsApp numbers, so we take reports seriously.

## Reporting a problem

Please **don't** open a public issue for a security problem. Instead use GitHub's private report:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce
it, and what someone could do with it. You'll get a reply within a few days.

Please don't test against the live site in ways that could affect members: no automated scanning
at volume, no attempts to read other members' data, and no messages to members. A local copy
(`npm install && npm start`) behaves the same way and is the right place to experiment.

## What's in place

See [docs/security.md](docs/security.md) for how the app and server are protected, the operator's
checklist, and what to do if a key leaks. The server can be checked any time with
`sudo muhallareads-security-check`.

This repository contains no secrets: keys and tokens live only in the server's settings file
(`/etc/muhallareads/muhallareads.env`), never in git.

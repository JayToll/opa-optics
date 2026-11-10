# Security policy

OPA Optics runs inside the Okta Privileged Access console with the signed-in user's session, so security issues are taken seriously.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Report it privately through GitHub: go to this repository's **Security** tab and choose **Report a vulnerability**. Include:

- what the problem is and how it could be exploited;
- steps to reproduce it, using a demo or test team;
- the version affected (the `@version` number at the top of `opa-optics.user.js`).

Please leave out real tenant names, hostnames, usernames, session tokens and exported data.

You'll get an acknowledgement as soon as practical. Fixes are released as a new version, with the change noted in the changelog once users have had a chance to update.

## Scope

In scope:

- the tool sending the session token, or any data, anywhere other than the signed-in Okta Privileged Access address;
- the tool making any request that changes data;
- content from the API being run as code in the page (for example unescaped names);
- CSV exports that could run formulas in spreadsheet programs;
- the published bookmarklet or install page not matching the source.

Out of scope:

- weaknesses in Okta Privileged Access itself. Report those to Okta;
- access results that differ from Okta's own evaluation. Those are bugs, so please open a normal issue.

## Supported versions

Only the latest version receives fixes. Tampermonkey users get updates automatically; bookmarklet users should re-add the bookmarklet from the install page.

# Changelog

All notable changes to OPA Optics. Versions follow the `@version` number in `opa-optics.user.js`.

## 1.5.2 (10 November 2026)

- The server page banner now starts where the console's left-hand menu ends, so it no longer covers the menu.
- New **Position** setting on each panel. The server panel can sit at the bottom, right or left. The grouped server list and user panel can sit on the right or left. Left places them beside the console's menu, not over it. Your choices are remembered.

## 1.5.1 (10 November 2026)

- Server pages: the access panel is now a banner along the bottom of the page. The answer and the policies giving you access show in the banner's top line, so it's still useful with details hidden. Your show or hide choice is remembered.

## 1.5.0 (10 November 2026)

- New Licence tab for admins: estimates resource units from active users and service users, servers checked in within 24 hours, connected SaaS apps and managed Active Directory accounts, using the resource unit calculator's rates.
- Type over any count to try a different figure, for example the highest daily server average for elastic fleets.
- Enter the number of resource units bought to see spare capacity or overage. Saved per team in your browser.
- Shows how many Universal Directory licences the users need, and exports the estimate as CSV.

## 1.4.3 (2 November 2026)

- Script header now states it is unofficial and not made or supported by Okta.
- Recommends Violentmonkey (open source) alongside Tampermonkey.
- User panel wording for users with only on-request access.
- README screenshots, rendered with fictional demo data.

## 1.4.2 (2 November 2026)

- Added update and download addresses, so Tampermonkey installs update automatically from this repository.
- Added project and issue tracker links to the script.
- Install page now hosted on GitHub Pages, with Tampermonkey install steps.
- Added a build script that produces the bookmarklet and install page from the source.

## 1.4.1 (2 November 2026)

- Renamed the tool to OPA Optics. The saved grouping settings key changed, so grouping choices reset once.

## 1.4.0 (2 November 2026)

- Added the Health tab: policy checks (inactive, matching no servers, nobody in their groups, servers no policy covers), server agent checks (not seen recently, behind the latest version in use, versions and states) and admin role review, each with a CSV export.

## 1.3.0 (2 November 2026)

- Added enrolled clients to the user panel, with a warning for active clients on disabled or deleted users.

## 1.2.0 (2 November 2026)

- The grouped server list opens automatically on the home page, with an option to turn this off.

## 1.1.1 (2 November 2026)

- Only shows the "wrong site" alert when run outside the Okta Privileged Access console.

## 1.1.0 (2 November 2026)

- Added the user panel: servers a user can reach, standing vs on-request access, and CSV export.

## 1.0.0 (2 November 2026)

- First release: grouped server list on the home page and the "why do I have access?" panel on server pages.

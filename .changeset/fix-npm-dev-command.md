---
"create-pds": patch
---

Fix npm command in next steps message

The CLI now correctly displays `npm run dev` instead of `npm dev` when npm is selected as the package manager. This ensures users receive valid commands that will actually work.

---
"@getcirrus/pds": patch
---

Fix authentication loss by reducing access token lifetime to 15 minutes

Reduces access token lifetime from 2 hours to 15 minutes to match the official Bluesky PDS implementation and AT Protocol OAuth specification (which recommends 1-5 minutes with a maximum of 1 hour).

This fixes the periodic authentication loss issue where the Bluesky app and web interface would lose authentication and require account switching or page reload to recover. Short-lived tokens force regular refresh cycles, keeping sessions fresh and properly synchronized with the app's token management.

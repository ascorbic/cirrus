---
"@getcirrus/pds": patch
---

Add updateEmail endpoint and include email in session responses

Store email in DO storage and return it from getSession, createSession, and refreshSession responses. Fixes deck.blue and official app complaints about missing email field.

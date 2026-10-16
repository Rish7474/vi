# Privacy Policy for Vi

**Last Updated:** October 16, 2026

Vi ("we", "our", or "the extension") is a browser extension developed to assist users in accessing transcripts and asking questions about publicly streamed New York City and New York State government hearings.

### 1. Information Collection and Use
- **User Queries**: When you ask a question using the Ask Vi chat interface, your question and relevant public hearing captions are sent to our secure backend service (`https://vi-m5ke.onrender.com`) solely to generate the cited answer. Queries are not used for advertising, profiling, or training external models.
- **Transcripts**: Captions and transcripts processed by the extension are public government hearing records streamed from official city and state portals (e.g., NYC Council, Granicus, Legistar).
- **Local Storage**: Vi uses browser local storage (`chrome.storage.local`) exclusively to save user interface preferences (such as drawer width and backend service endpoint). This data never leaves your device.

### 2. Data Sharing and Third Parties
- Vi does **not** sell, rent, monetize, or trade any user data to third parties.
- Vi does **not** collect personal identification information (PII), browsing history across unrelated websites, IP addresses for tracking, or keystrokes.

### 3. Permissions
- `activeTab` & `tabs`: Used solely to detect when a supported government hearing video is active on the current tab.
- `downloads`: Used solely when the user clicks "Download Transcription" to save the transcript to their local device.
- `storage`: Used solely to save local extension settings.
- `host_permissions`: Required to fetch public captions from government media servers and send Q&A prompts to the Vi backend service.

### 4. Contact & Open Source
Vi is an open-source tool. For questions, issues, or contributions, visit:
https://github.com/Rish7474/vi

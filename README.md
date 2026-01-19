# 🤖 Otto CLI

**AI-powered Git Release & Automation Tool**

Otto is a CLI tool that automates your git workflow. It generates conventional commit messages using AI, manages semantic versioning, handles branch management, and logs every release to a Google Sheet automatically.

## 🚀 Quick Start

No installation required. Run it directly with `npx`:

```bash
npx otto-cli

```

*(Ensure you are inside a Git repository)*

---

## 🔑 Configuration

Otto requires an OpenAI API key to generate commit messages. Optionally, you can connect a Google Sheet to log your releases.

You can set these variables in a `.env` file in your project root, or export them in your terminal.

### Option 1: Using `.env` (Recommended)

Create a `.env` file in your project root:

```ini
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxx
GOOGLE_SHEET_WEBHOOK_URL=https://script.google.com/macros/s/xxxx/exec

```

### Option 2: Using Terminal Exports

```bash
export OPENAI_API_KEY="sk-proj-xxxxxxxx"
export GOOGLE_SHEET_WEBHOOK_URL="https://script.google.com/..."

npx otto-cli

```

---

## 📊 Google Sheets Setup (Optional)

To enable automatic release logging, follow these steps to set up the Webhook:

1. **Create a New Sheet**: Go to [sheets.new](https://sheets.new) and create a blank spreadsheet.
2. **Open Apps Script**: Click **Extensions** > **Apps Script**.
3. **Paste the Script**: Delete any existing code and paste the following:
```javascript
function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    const data = JSON.parse(e.postData.contents);

    // Columns: Timestamp | User | Branch | Type | Commit Msg | Technical Description
    sheet.appendRow([
      new Date(),       // Timestamp
      data.user,        // Git Username
      data.branch,      // Branch Name
      data.type,        // Release Type
      data.message,     // The Commit Subject
      data.description  // Technical Summary
    ]);

    return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

```


4. **Deploy as Web App**:
* Click the blue **Deploy** button (top right) > **New deployment**.
* Click the **Gear icon** (Select type) > **Web app**.
* **Description**: `Otto Logger`
* **Execute as**: `Me` (your email).
* **Who has access**: `Anyone` (**Crucial**: This allows the CLI to POST data without OAuth).
* Click **Deploy**.


5. **Get the URL**: Copy the **Web app URL** generated (starts with `https://script.google.com/...`) and add it to your environment variables as `GOOGLE_SHEET_WEBHOOK_URL`.

---

## 🛠 Features

### 🚀 Release Flow

* **AI Commits**: Generates "Conventional Commit" messages and technical descriptions based on your staged changes.
* **Versioning**: Handles `npm version` (patch, minor, major) automatically.
* **Build & Push**: Runs build scripts (if present), tags the release, and pushes to remote.
* **Logging**: Logs details to your Google Sheet.

### 🌿 Branch Manager

* **Smart Switch**: Stashes your current work, switches branches, and pops the stash automatically.
* **Create**: Quickly create new branches.
* **PR**: Opens a Pull Request link for the current branch in your browser.

### ⏪ History & Undo

* **Visual Log**: See a clean list of recent commits.
* **Reset**: Perform Soft, Mixed, or Hard resets to previous commits easily.

### 🔄 Smart Sync

* **Auto-Detection**: On startup, checks if your local branch is behind remote.
* **One-Click Pull**: Prompts you to pull changes before you start working.
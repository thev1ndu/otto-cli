```
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
      data.message,     // The Commit Subject (e.g., feat: add login)
      data.description  // The "How it was done" paragraph
    ]);

    return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```
/**
 * Google Apps Script — receives leads from bot.js and appends them to a spreadsheet.
 *
 * Setup (about 5 minutes):
 *   1. Create a Google Sheet, open Extensions → Apps Script.
 *   2. Paste this file, then run setup() once and allow access.
 *   3. Project settings → Script properties → add TOKEN = <a long random string>.
 *   4. Deploy → New deployment → type "Web app":
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the /exec URL into SHEETS_WEBHOOK_URL and the same TOKEN into SHEETS_TOKEN.
 *
 * Columns: Timestamp | Lead ID | Service | Name | Contact | Comment | Chat ID | Username
 */

const SHEET_NAME = "Leads";
const HEADER = ["Timestamp", "Lead ID", "Service", "Name", "Contact", "Comment", "Chat ID", "Username"];

function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.getRange(1, 1, 1, HEADER.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return "Sheet ready";
}

function doPost(event) {
  try {
    const body = JSON.parse((event.postData && event.postData.contents) || "{}");
    const expected = PropertiesService.getScriptProperties().getProperty("TOKEN");
    if (expected && body.token !== expected) {
      return respond({ ok: false, error: "forbidden" });
    }

    const lead = body.lead || {};
    if (!lead.name || !lead.contact) {
      return respond({ ok: false, error: "name and contact are required" });
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) setup();

    sheet.appendRow([
      new Date(),
      lead.id || "",
      lead.serviceLabel || lead.service || "",
      lead.name,
      lead.contact,
      lead.comment || "",
      lead.chatId || "",
      lead.username || "",
    ]);

    return respond({ ok: true, id: lead.id || null });
  } catch (error) {
    return respond({ ok: false, error: String(error) });
  }
}

function doGet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  return respond({ ok: true, service: "leadcatcher", rows: sheet ? Math.max(0, sheet.getLastRow() - 1) : 0 });
}

function respond(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

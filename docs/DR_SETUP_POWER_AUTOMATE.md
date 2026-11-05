# Set up AiPM backups to your OneDrive with Power Automate (no IT needed)

**Time:** about 20 minutes, one time.
**You need:** access to the AiPM Replit workspace, Power Automate, and your Swinerton OneDrive.
**You do NOT need:** IT, an app registration, or any premium Power Automate license. This guide only uses standard OneDrive actions.

## How it works

Every night your own Power Automate flow, signed in as you, downloads a complete AiPM backup
through a secret link and saves it in your Swinerton OneDrive:

```
OneDrive / AiPM Disaster Recovery /
   00 READ ME FIRST - How to Restore AiPM.md    ← plain instructions, updated nightly
   Daily /   AiPM-Backup-Monday.zip … AiPM-Backup-Sunday.zip      ← last 7 days
   Monthly / AiPM-Backup-01-January.zip … 12-December.zip         ← last 12 months
```

Each night's file replaces the one with the same name from a week (or a year) earlier, so old
backups clean themselves up. Each .zip is a complete backup on its own: all data, all files,
the app code, and the restore steps.

---

## Step 1: Make a secret password for the backup link

Use a password generator to make a **long password of letters and numbers only**, about 40
characters. Avoid symbols like `& # ? % +`, because they break web links.

Example format (don't use this one): `k7Qm2Xp9Lw4Rt8Vn3Bs6Hy1Jd5Fg0ZcA2eMuP7Wq`

Save it in your password manager.

## Step 2: Put the password into Replit

1. Open the AiPM Replit workspace → **Tools** → **Secrets** → **New secret**.
2. Key: `DR_BACKUP_TRIGGER_TOKEN`. Value: your password from Step 1.
3. Click **Publish / Republish** so the live app picks it up. (The live app must have this backup
   feature merged in. If it's not live yet, do the steps in `CLAUDE.md` first.)

## Step 3: Test the link in your browser

Paste this into your browser, using your live AiPM address and your password:

```
https://YOUR-AIPM-ADDRESS/api/dr-backup/download?token=YOUR-PASSWORD&file=guide
```

After up to about a minute (it builds a fresh backup), a file named
`00 READ ME FIRST - How to Restore AiPM.md` downloads. That means the link works.
"Unauthorized" means the password doesn't match. Re-check Step 2 and that you republished.

## Step 4: Create the folders in OneDrive

In your Swinerton OneDrive, create a folder `AiPM Disaster Recovery`, and inside it two folders:
`Daily` and `Monthly`.

**Recommended:** share the `AiPM Disaster Recovery` folder with one trusted coworker. Then the
backups aren't tied to only your account.

## Step 5: Build the flow

You can let Copilot build it (5a) or build it by hand (5b). Either way, check it against 5b.

### 5a: Ask Copilot in Power Automate

Go to **make.powerautomate.com** → **Create** → **Describe it to design it** (Copilot), and paste:

> Create a scheduled cloud flow that runs every day at 1:30 AM Pacific time. It has three actions,
> all using the OneDrive for Business connector:
> 1. "Upload file from URL". Source URL: https://YOUR-AIPM-ADDRESS/api/dr-backup/download?token=YOUR-PASSWORD&file=guide
>    Destination file path: /AiPM Disaster Recovery/00 READ ME FIRST - How to Restore AiPM.md
>    Overwrite: Yes.
> 2. "Upload file from URL". Source URL: https://YOUR-AIPM-ADDRESS/api/dr-backup/download?token=YOUR-PASSWORD
>    Destination file path: /AiPM Disaster Recovery/Daily/AiPM-Backup-@{formatDateTime(convertFromUtc(utcNow(),'Pacific Standard Time'),'dddd')}.zip
>    Overwrite: Yes.
> 3. "Copy file". File: the Id from step 2.
>    Destination file path: /AiPM Disaster Recovery/Monthly/AiPM-Backup-@{formatDateTime(convertFromUtc(utcNow(),'Pacific Standard Time'),'MM-MMMM')}.zip
>    Overwrite: Yes.
> Name the flow "AiPM nightly backup to OneDrive".

### 5b: The exact settings (by hand, or to check Copilot's work)

1. **Create** → **Scheduled cloud flow**. Name: `AiPM nightly backup to OneDrive`. Repeat every **1 day**, at **1:30 AM**, time zone **(UTC-08:00) Pacific Time**.
2. **+ New step** → search **OneDrive for Business** → **Upload file from URL**:
   * Source URL: `https://YOUR-AIPM-ADDRESS/api/dr-backup/download?token=YOUR-PASSWORD&file=guide`
   * Destination File Path: `/AiPM Disaster Recovery/00 READ ME FIRST - How to Restore AiPM.md`
   * Overwrite: **Yes**
3. **+ New step** → **OneDrive for Business** → **Upload file from URL**:
   * Source URL: `https://YOUR-AIPM-ADDRESS/api/dr-backup/download?token=YOUR-PASSWORD`
   * Destination File Path: type `/AiPM Disaster Recovery/Daily/AiPM-Backup-`, then insert this
     **Expression**: `formatDateTime(convertFromUtc(utcNow(),'Pacific Standard Time'),'dddd')`, then type `.zip`
   * Overwrite: **Yes**
4. **+ New step** → **OneDrive for Business** → **Copy file**:
   * File: pick **Id** from the step above (dynamic content)
   * Destination File Path: type `/AiPM Disaster Recovery/Monthly/AiPM-Backup-`, insert the **Expression**
     `formatDateTime(convertFromUtc(utcNow(),'Pacific Standard Time'),'MM-MMMM')`, then type `.zip`
   * Overwrite: **Yes**
5. **Save**.

## Step 6: Test it

1. In the flow, click **Test** → **Manually** → **Run flow**.
2. Wait for all three steps to show green checkmarks (a few minutes).
3. Open OneDrive. You should see the READ ME file, one .zip in `Daily`, and one in `Monthly`.
4. Open AiPM → **Admin → Data Backup & Recovery**. The card should say **Protected**, with a
   history row reading "Saved to Microsoft 365 · Power Automate → OneDrive".

## Staying safe over time

* **If the flow fails**, Power Automate emails you automatically, and the AiPM admin card turns red after a missed night.
* **Glance at the admin card weekly.** Green means you're covered.
* **Once a quarter,** have a developer test-restore the newest Daily zip (instructions are inside the READ ME file).
* **Don't share the backup link or the password.** Anyone with both can download the backup. If either leaks,
  change the password in Replit Secrets (Step 2) and in the flow (Step 5).
* **If you change the AiPM web address,** update the two links in the flow.

## If something goes wrong

| What you see | What to do |
|---|---|
| Step 2 or 3 of the flow fails with a timeout | Run it again. The backup is built during the first try and reused on the second. If it keeps failing, tell your developer the exact error. |
| "Unauthorized" (401) | The password in the flow doesn't match the Replit Secret, or the app wasn't republished. |
| A file-size or "request entity too large" error | Tell your developer. They can set the Replit Secret `DR_INCLUDE_SOURCE_CODE` to `false` to make the file much smaller (the app code is then recovered from GitHub instead). |
| Folder not found | Check the folder names in OneDrive exactly match Step 4. |

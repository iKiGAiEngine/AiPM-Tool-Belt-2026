import { useMemo } from "react";
import { Link, useRoute } from "wouter";
import {
  LifeBuoy, ArrowLeft, Link2, FolderPlus, FileBarChart,
  ClipboardList, TableProperties, Calculator, Camera,
  ChevronRight,
} from "lucide-react";

import shotHomePage from "@assets/sop-screenshots/01-home-page.png";
import shotProposalLog from "@assets/sop-screenshots/10-proposal-log-dashboard.png";
import shotBcSyncTable from "@assets/sop-screenshots/11-bc-sync-table-admin.png";
import shotProjectStart from "@assets/sop-screenshots/20-project-start.png";
import shotSpecExtractor from "@assets/sop-screenshots/30-spec-extractor.png";
import shotScheduleConverter from "@assets/sop-screenshots/40-schedule-converter.png";

interface SopStep {
  title: string;
  body: string | string[];
  screenshot?: string;
  image?: string;
  tip?: string;
}

interface SopSection {
  heading: string;
  steps: SopStep[];
}

interface Sop {
  slug: string;
  title: string;
  description: string;
  icon: typeof FolderPlus;
  estimatedReadMin: number;
  intro: string;
  whoFor: string;
  sections: SopSection[];
}

const SOPS: Sop[] = [
  {
    slug: "bc-sync",
    title: "BuildingConnected Sync",
    description: "How bid invitations flow from BuildingConnected into the Proposal Log.",
    icon: Link2,
    estimatedReadMin: 4,
    intro:
      "BuildingConnected (BC) Sync is how new bid invitations land in our system automatically. Instead of typing every invite into the Proposal Log by hand, the sync pulls them in as 'Drafts' that an admin reviews and approves.",
    whoFor:
      "Admins run the sync and approve drafts. Estimators may be assigned a project once it's approved.",
    sections: [
      {
        heading: "What BC Sync Does",
        steps: [
          {
            title: "Pulls new opportunities from your BC account",
            body: [
              "When you click Sync, the app reaches out to BuildingConnected and pulls every new opportunity it hasn't seen before.",
              "For each opportunity it grabs the project name, GC, due date, project address, anticipated start/finish dates, square footage, and the BC link.",
            ],
          },
          {
            title: "Creates Drafts (not live entries)",
            body:
              "New invitations don't go straight into the Proposal Log. They land in a Drafts queue first, so an admin can review and clean them up before they become real entries.",
          },
        ],
      },
      {
        heading: "Running the Sync",
        steps: [
          {
            title: "Open the Proposal Log",
            body:
              "From the home page, click the Proposal Log Dashboard tile. The sync controls are at the top of the page (admin-only — non-admins won't see them).",
            screenshot: "Proposal Log Dashboard — sync controls at the top (admin view)",
            image: shotProposalLog,
          },
          {
            title: "Click Sync",
            body: [
              "The button will show a spinner while it runs. Most syncs finish in 5–15 seconds depending on how many new invites there are.",
              "When it's done, you'll see a toast telling you how many drafts were created.",
            ],
            screenshot: "Sync running with spinner + completion toast",
          },
          {
            title: "Open the Drafts queue",
            body:
              "If new drafts were created, a banner appears at the top of the Proposal Log with a 'Review Drafts' button. Click it to see the queue.",
            screenshot: "Drafts banner with Review Drafts button",
          },
        ],
      },
      {
        heading: "Reviewing & Approving a Draft",
        steps: [
          {
            title: "Open a draft to review",
            body:
              "Click any row in the Drafts queue. The Review Draft modal opens showing everything BC pulled, plus fields you can fill in or correct.",
            screenshot: "Review Draft modal open",
          },
          {
            title: "Confirm the auto-filled fields",
            body: [
              "BC fills in: Project Name, GC, Due Date, Project Address, Anticipated Start, Anticipated Finish, Square Feet, BC Link.",
              "Double-check each one. If BC had bad data, fix it here before approving.",
            ],
            tip: "If the address is missing or wrong, that's usually because the GC didn't fill it in on their end. Fix it now — it's harder to fix later.",
          },
          {
            title: "Fill in the fields BC doesn't know",
            body:
              "Set the Region, Primary Market, and any internal notes. Pick the Estimator who should own this bid (if known yet — you can assign later too).",
            screenshot: "Region / Market / Estimator dropdowns in Review Draft modal",
          },
          {
            title: "Approve and create the project",
            body: [
              "Click Approve & Create Project. The system will:",
              "• Create a real Proposal Log entry",
              "• Generate the next estimate number",
              "• Create the project folder structure",
              "• Stamp the estimate Excel template with the project info",
              "The draft disappears from the queue and the new row shows up in the live Proposal Log.",
            ],
            screenshot: "Approve & Create Project button + success toast",
          },
          {
            title: "OR — Reject the draft",
            body:
              "If the invite is junk (wrong scope, duplicate, GC we don't bid for, etc.), click Reject. The draft is removed and won't come back on the next sync.",
          },
        ],
      },
      {
        heading: "Common Issues",
        steps: [
          {
            title: "I synced but nothing showed up",
            body:
              "That just means BC didn't have any new invitations since the last sync. It's not an error.",
          },
          {
            title: "A draft has the wrong project name",
            body:
              "Edit it in the Review Draft modal before approving. Once approved, you can still rename it inline in the Proposal Log.",
          },
          {
            title: "I don't see the Sync button",
            body:
              "Sync is admin-only. If you're an admin and still don't see it, hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).",
          },
        ],
      },
    ],
  },

  {
    slug: "project-start",
    title: "Project Start",
    description: "Create a new project with plans and specs (manual entry path).",
    icon: FolderPlus,
    estimatedReadMin: 5,
    intro:
      "Project Start is the manual path for creating a new project — used when a bid didn't come through BuildingConnected (email invite, walk-in, etc.). It sets up the same project structure that BC approval creates.",
    whoFor: "Anyone creating a new project that isn't from a BC invite.",
    sections: [
      {
        heading: "When To Use Project Start vs. BC Sync",
        steps: [
          {
            title: "Use BC Sync if the bid came from BuildingConnected",
            body:
              "Don't create a duplicate. Run BC Sync first and approve the draft — that's faster and pulls more data automatically.",
          },
          {
            title: "Use Project Start for everything else",
            body:
              "Email invites, phone calls, walk-ins, internal projects — anything not in BC.",
          },
        ],
      },
      {
        heading: "Creating the Project",
        steps: [
          {
            title: "Open Project Start from the home page",
            body: "Click the Project Start tile on the home page.",
            screenshot: "Home page — Project Start tile (top row)",
            image: shotHomePage,
          },
          {
            title: "Enter the basics",
            body: [
              "Fill in Project Name, GC, Region, Primary Market, Due Date.",
              "If you have a screenshot of the invite (BC invite email, project listing, etc.), drag it into the Quick Fill from Screenshot area at the top — the app will read it and auto-fill what it can.",
            ],
            screenshot: "Project Start — full form (Quick Fill, Project Details, Intake, Documents)",
            image: shotProjectStart,
            tip: "OCR works best on clean, high-resolution screenshots. If a field comes back wrong, just type over it.",
          },
          {
            title: "Upload plans (PDF)",
            body:
              "Drop the plans PDF into the Plans upload area. Big files (up to 30 MB) are fine — anything bigger you'll need to split or zip.",
            screenshot: "Plans upload area",
          },
          {
            title: "Upload specs (PDF)",
            body:
              "Drop the specs PDF into the Specs upload area. The Spec Extractor will run on it automatically once the project is created.",
            screenshot: "Specs upload area",
          },
          {
            title: "Click Create Project",
            body: [
              "The system creates the project, stamps the estimate template, generates the folder structure, and kicks off Spec Extraction.",
              "You'll be taken to the project detail page when it's done.",
            ],
            screenshot: "Create Project button + project detail page after creation",
          },
        ],
      },
      {
        heading: "After Creation",
        steps: [
          {
            title: "Review the Spec Extractor results",
            body:
              "Spec extraction runs in the background. Check back in a few minutes (or refresh the project page) to see the extracted Division 10 sections. See the Spec Extractor SOP for review/edit details.",
          },
          {
            title: "The project is now in the Proposal Log",
            body:
              "A row was added to the Proposal Log with the next estimate number. You can edit any field there inline.",
          },
        ],
      },
    ],
  },

  {
    slug: "proposal-log",
    title: "Proposal Log",
    description: "How to read, edit, and manage proposals in the Proposal Log dashboard.",
    icon: FileBarChart,
    estimatedReadMin: 6,
    intro:
      "The Proposal Log is the heart of the system. Every active bid lives here. This SOP covers how to read it, what each column means, how to edit, and the rules everyone needs to follow.",
    whoFor: "Every estimator. Admins have a few extra controls noted below.",
    sections: [
      {
        heading: "Anatomy of a Row",
        steps: [
          {
            title: "Project name + due date",
            body:
              "On the left. The due date shows in business days remaining (e.g., '3BD' = due in 3 business days, 'Overdue' = past due).",
            screenshot: "Proposal Log Dashboard — full view with rows, status pills, and filters",
            image: shotProposalLog,
          },
          {
            title: "Status",
            body: [
              "The status drives the lifecycle: New → Estimating → Submitted → Won / Lost / No-Bid.",
              "Click the status pill to change it. Status changes are logged.",
            ],
            screenshot: "Status pill dropdown",
          },
          {
            title: "Estimator",
            body:
              "Who owns this bid. Click to assign or change. Only admins can reassign a bid that's already been worked on.",
          },
          {
            title: "Region & Market",
            body:
              "Used for filtering and reporting. Click either to change it inline.",
          },
          {
            title: "Notes & Comments",
            body:
              "Free-form text for anything else. Notes show as a tooltip on hover.",
          },
          {
            title: "Bid source link",
            body:
              "Small icon on the right of the project name — click it to jump to the BC opportunity, the source email, or the source attachment.",
            screenshot: "Bid source icon variants (BC link, email, attachment, folder)",
          },
        ],
      },
      {
        heading: "Editing Rules",
        steps: [
          {
            title: "Most fields edit inline — just click",
            body:
              "Status, estimator, region, market, dates, notes, scope checklist — all editable in place. Changes save automatically.",
          },
          {
            title: "Don't change someone else's bid without telling them",
            body:
              "It's tempting to fix a typo on someone else's row. Do it — but mention it in the comments so they know.",
          },
          {
            title: "Status changes are tracked",
            body:
              "Every status change is logged with who/when. Admins can review the change log if there's a question about who moved what.",
          },
        ],
      },
      {
        heading: "Status Lifecycle",
        steps: [
          {
            title: "New",
            body:
              "Just landed. No estimator assigned yet, or estimator hasn't started. Should move to Estimating within a day or two.",
          },
          {
            title: "Estimating",
            body:
              "Actively being worked. Should have an estimator assigned and a due date.",
          },
          {
            title: "Submitted",
            body:
              "Proposal sent to the GC. Move it here when you hit send. Add the Proposal Total in the field.",
          },
          {
            title: "Won / Lost / No-Bid",
            body: [
              "Final states.",
              "Won: We're doing the project.",
              "Lost: GC awarded to someone else.",
              "No-Bid: We chose not to submit (wrong scope, no time, etc.).",
            ],
            tip: "Always set a final state — don't leave bids in Submitted forever. Clean Proposal Log = useful Proposal Log.",
          },
        ],
      },
      {
        heading: "Filters & Views",
        steps: [
          {
            title: "Filter by estimator, region, market, status",
            body:
              "Use the filter bar at the top. Filters stack — pick estimator + region + status to narrow down.",
            screenshot: "Filter bar with multiple filters active",
          },
          {
            title: "Search",
            body:
              "Search box at the top right finds matches in project name, GC, notes, and estimate number.",
          },
          {
            title: "Admin-only views",
            body:
              "Admins see Drafts, archived rows, and the change log. Estimators only see active rows.",
          },
        ],
      },
      {
        heading: "Common Mistakes To Avoid",
        steps: [
          {
            title: "Forgetting to set Region or Market",
            body:
              "These drive reporting. A bid with no region/market won't show up in regional reports or pipelines.",
          },
          {
            title: "Leaving status as 'New' for weeks",
            body:
              "If you're working it, mark it Estimating. If you're not, set it to No-Bid.",
          },
          {
            title: "Putting the proposal total in the notes",
            body:
              "There's a dedicated Proposal Total field — use it. Notes don't roll up into reports.",
          },
        ],
      },
    ],
  },

  {
    slug: "spec-extractor",
    title: "Spec Extractor",
    description: "Automated Division 10 spec extraction from project specs PDFs.",
    icon: ClipboardList,
    estimatedReadMin: 4,
    intro:
      "Spec Extractor pulls Division 10 sections out of a specs PDF automatically. It uses pattern matching plus AI review for tricky labels. The result is a clean folder of one PDF per spec section.",
    whoFor: "Any estimator working a Division 10 bid.",
    sections: [
      {
        heading: "Two Ways To Run It",
        steps: [
          {
            title: "Automatic (recommended)",
            body:
              "When you upload specs in Project Start (or as part of BC approval), Spec Extractor runs automatically. You'll see results on the project detail page.",
          },
          {
            title: "Manual / standalone",
            body:
              "You can also run it on any PDF without creating a project — open the Spec Extractor tile from the home page and drop a PDF in.",
            screenshot: "Spec Extractor — standalone upload page",
            image: shotSpecExtractor,
          },
        ],
      },
      {
        heading: "Reviewing the Results",
        steps: [
          {
            title: "Open the project detail page",
            body:
              "From the Proposal Log, click the project name. The Spec Extractor results show in a list — one row per detected section.",
            screenshot: "Project detail page with Spec Extractor results list",
          },
          {
            title: "Check the section labels",
            body: [
              "Each row shows the section number, the label the AI suggested, and a confidence badge.",
              "Green = high confidence, yellow = medium (review it), red = low (definitely review).",
            ],
            screenshot: "Section list with confidence badges",
          },
          {
            title: "Edit a label if it's wrong",
            body:
              "Click the label to edit it inline. Common fixes: cleaning up an OCR'd title, splitting a combined section, or correcting an obvious AI miss.",
          },
          {
            title: "Preview the extracted PDF",
            body:
              "Click the eye icon on any row to see the actual extracted PDF for that section.",
            screenshot: "Extracted section PDF preview",
          },
        ],
      },
      {
        heading: "Exporting",
        steps: [
          {
            title: "Download all as ZIP",
            body:
              "Click 'Download All' at the top of the section list. You get a ZIP with one PDF per section, named by section number + label.",
            screenshot: "Download All button + downloaded ZIP contents",
          },
          {
            title: "Download one section",
            body:
              "Click the download icon on any row to grab just that section's PDF.",
          },
        ],
      },
      {
        heading: "Tips",
        steps: [
          {
            title: "Review yellow and red badges before exporting",
            body:
              "These are the ones the AI wasn't sure about. A 30-second review now saves a 10-minute fix later.",
          },
          {
            title: "Re-run if the specs change",
            body:
              "If the GC issues an addendum with revised specs, upload the new PDF and re-run extraction. Old results are kept until you delete them.",
          },
        ],
      },
    ],
  },

  {
    slug: "schedule-converter",
    title: "Schedule Converter",
    description: "Turn schedule screenshots or text into a structured estimate-ready table.",
    icon: TableProperties,
    estimatedReadMin: 3,
    intro:
      "Schedule Converter takes a schedule (a screenshot from a plan, a copy/paste from a spec, or even a photo) and turns it into a clean, structured table you can verify and export. It uses an AI vision model to read the schedule.",
    whoFor: "Any estimator dealing with door schedules, hardware schedules, partition schedules, etc.",
    sections: [
      {
        heading: "Running the Converter",
        steps: [
          {
            title: "Open Schedule Converter from the home page",
            body: "Click the Schedule Converter tile.",
            screenshot: "Home page — Schedule Converter tile",
            image: shotHomePage,
          },
          {
            title: "Paste a screenshot or upload an image",
            body: [
              "Two ways to give it the schedule:",
              "• Paste an image directly (Ctrl+V / Cmd+V) from your clipboard",
              "• Upload an image file (PNG, JPG)",
              "You can also switch to the Text tab and paste schedule text instead.",
              "Higher resolution = better results.",
            ],
            screenshot: "Schedule Converter — Image paste/upload area",
            image: shotScheduleConverter,
          },
          {
            title: "Click Convert",
            body:
              "The AI processes the image and returns a structured table. Usually takes 5–15 seconds.",
            screenshot: "Convert button + result table",
          },
        ],
      },
      {
        heading: "Verifying the Output",
        steps: [
          {
            title: "Always do a row-by-row spot check",
            body:
              "AI vision is good but not perfect. Compare the table against the source image — especially the quantities and any odd-looking text.",
            tip: "If the schedule is small or low-res, the AI is more likely to misread numbers. Re-do it with a higher-res capture if you see misses.",
          },
          {
            title: "Edit any cell that's wrong",
            body:
              "Click any cell to edit. Changes are kept locally until you export.",
          },
        ],
      },
      {
        heading: "Exporting",
        steps: [
          {
            title: "Export to Excel",
            body:
              "Click Export to download the table as an .xlsx file. Open it and copy/paste the rows into your estimate.",
            screenshot: "Export to Excel button",
          },
          {
            title: "Copy to clipboard",
            body:
              "Or use Copy to Clipboard to grab the rows in TSV format and paste straight into your estimate.",
          },
        ],
      },
    ],
  },

  {
    slug: "estimating-module",
    title: "Estimating Module (Deep-Dive)",
    description: "The full estimating workflow: project info → line items → RFQs → proposal.",
    icon: Calculator,
    estimatedReadMin: 12,
    intro:
      "The Estimating Module is the longest and most-used workflow in the app. This SOP walks through every stage. Take your time — there's a lot here, and the order matters.",
    whoFor: "Every estimator. The whole bid lifecycle lives in this module.",
    sections: [
      {
        heading: "Opening an Estimate",
        steps: [
          {
            title: "Open from the Proposal Log",
            body:
              "From the Proposal Log, click the estimate number on any row. That opens the Estimating Module for that project.",
            screenshot: "Proposal Log row with estimate number link",
          },
          {
            title: "The four-stage layout",
            body: [
              "The module is organized as four stages, shown as tabs across the top:",
              "1. Project Info — overall project details",
              "2. Line Items — every item being bid, by scope",
              "3. RFQs — sending out vendor quote requests",
              "4. Proposal — finalizing and exporting the proposal",
              "You can move between them freely, but most bids flow left-to-right.",
            ],
            screenshot: "Estimating module tab bar",
          },
        ],
      },
      {
        heading: "Stage 1 — Project Info",
        steps: [
          {
            title: "Confirm the auto-filled fields",
            body:
              "Most fields here were filled in when the project was created (from BC or Project Start). Double-check Project Name, GC, Region, Market, Due Date, Square Feet.",
          },
          {
            title: "Add anything missing",
            body:
              "Address, anticipated start/finish, addenda received, special notes — fill in whatever applies.",
            screenshot: "Project Info form",
          },
          {
            title: "Save",
            body:
              "Changes save automatically as you type. There's no Save button — just move on when you're done.",
          },
        ],
      },
      {
        heading: "Stage 2 — Line Items",
        steps: [
          {
            title: "Pick the active scope",
            body:
              "Each scope (toilet partitions, accessories, lockers, etc.) gets its own tab. Click the scope tab you want to work on.",
            screenshot: "Scope tabs in Line Items stage",
          },
          {
            title: "Add Approved Manufacturers (do this first)",
            body: [
              "Before adding line items, set the Approved Manufacturers card for this scope.",
              "Click Add Manufacturer and pick from the dropdown (or type a new one to create it on the fly).",
              "Optionally flag one as 'Basis of Design'.",
              "These are the manufacturers we're allowed to quote for this scope.",
            ],
            screenshot: "Approved Manufacturers card",
            tip: "The RFQ Generator pulls from this list later. If you skip this step, you'll have to do it before sending RFQs anyway.",
          },
          {
            title: "Add line items",
            body: [
              "Use the Add Item form above the table. For each item, fill in:",
              "• Description, quantity, unit",
              "• Manufacturer (typeahead — picks from the global manufacturer list, with this scope's Approved Manufacturers shown first marked with ★)",
              "• Model number, notes",
              "Press Enter or click Add to drop it into the table.",
            ],
            screenshot: "Add Item form + line items table",
            tip: "If you type a manufacturer name that doesn't exist, it'll auto-create one when you tab out. No need to leave this screen.",
          },
          {
            title: "Edit or delete line items",
            body:
              "Click any cell in the table to edit. Use the trash icon to delete a row. Changes save automatically.",
          },
          {
            title: "On a phone? Scroll right.",
            body:
              "On a small screen, the table scrolls horizontally instead of stacking. Swipe right to see all the columns.",
          },
        ],
      },
      {
        heading: "Stage 3 — RFQs",
        steps: [
          {
            title: "Open the RFQ Generator",
            body:
              "Click the RFQs tab. You'll see a card per manufacturer (default view), grouping every line item that uses that manufacturer.",
            screenshot: "RFQ Generator default view (per-manufacturer cards)",
          },
          {
            title: "Toggle Group by Vendor (often easier)",
            body: [
              "Use the Group by Vendor toggle to flip the cards. Now you see one card per eligible vendor, with every manufacturer they can quote for the active scope listed inside.",
              "This way PBS gets one consolidated email instead of three separate ones for Bobrick, Bradley, and ASI.",
            ],
            screenshot: "Group by Vendor toggle + vendor-grouped cards",
          },
          {
            title: "Send a per-card RFQ",
            body: [
              "Each card has a 'Pick Recipients & Send' button. Click it.",
              "A modal opens with every eligible contact pre-checked. Untick anyone you don't want to email.",
              "Click Send — your email client opens with a pre-filled mailto: containing the line items and contacts.",
            ],
            screenshot: "Pick Recipients modal + opened mail draft",
            tip: "The 'eligible' rule: a vendor must have no scope tags OR include the active scope, AND have no manufacturer tags OR include the manufacturer being quoted.",
          },
          {
            title: "Use Open RFQ for one-off requests",
            body: [
              "Need to send to a vendor who isn't tagged for this scope, or include only some line items? Click Open RFQ.",
              "Tick any subset of the scope's line items, then pick a recipient — either an existing vendor (typeahead) or a one-time vendor (free-form name + email).",
              "Add notes if you want (accessory list, special instructions, etc.).",
              "One-time vendors are NOT saved to the database — they're just for this email.",
            ],
            screenshot: "Open RFQ modal",
          },
        ],
      },
      {
        heading: "Stage 4 — Proposal",
        steps: [
          {
            title: "Pricing inputs come together",
            body:
              "As vendor quotes come back, you'll add pricing in the line items (and optionally upload the quote PDF for the AI to extract — see Vendor Quote AI Extraction in the change log).",
          },
          {
            title: "Review the proposal preview",
            body:
              "The Proposal tab shows a live preview of what will be sent — cover, scope summary, totals, exclusions/inclusions.",
            screenshot: "Proposal preview",
          },
          {
            title: "Export the proposal",
            body:
              "When everything looks right, click Export. You get the final stamped Excel + PDF ready to send to the GC.",
            screenshot: "Export button + exported files",
          },
        ],
      },
      {
        heading: "After Submitting",
        steps: [
          {
            title: "Update the Proposal Log status",
            body:
              "Go back to the Proposal Log and move the row to 'Submitted'. Add the Proposal Total. Don't forget — see the Proposal Log SOP.",
          },
          {
            title: "Save your work",
            body:
              "All estimating changes save automatically as you go. There's no separate save step. If your browser crashes mid-bid, you'll be right where you left off when you reopen.",
          },
        ],
      },
      {
        heading: "Common Mistakes",
        steps: [
          {
            title: "Skipping Approved Manufacturers",
            body:
              "Setting Approved Manufacturers up front saves time at the RFQ stage and keeps line items linked to the global manufacturer list.",
          },
          {
            title: "Free-typing manufacturer names that already exist",
            body:
              "Use the typeahead. 'Bobrick', 'BOBRICK', and 'Bobrick Inc.' are three different records if you type them fresh — and that breaks RFQ grouping.",
          },
          {
            title: "Forgetting to send addenda acknowledgment",
            body:
              "If the GC issued addenda, list them in Project Info. Some GCs reject proposals that don't acknowledge addenda.",
          },
        ],
      },
    ],
  },
];

function ScreenshotPlaceholder({ caption }: { caption: string }) {
  return (
    <div
      className="my-3 rounded-md border border-dashed flex items-center gap-3 px-4 py-6"
      style={{
        borderColor: "rgba(200, 164, 78, 0.4)",
        background: "rgba(200, 164, 78, 0.05)",
      }}
      data-testid="screenshot-placeholder"
    >
      <Camera style={{ width: 18, height: 18, color: "var(--gold)", flexShrink: 0 }} />
      <div className="text-sm" style={{ color: "var(--text-dim)" }}>
        <span style={{ color: "var(--gold)", fontWeight: 600 }}>Screenshot:</span> {caption}
      </div>
    </div>
  );
}

function ScreenshotImage({ src, caption }: { src: string; caption: string }) {
  return (
    <figure
      className="my-3 rounded-md overflow-hidden border"
      style={{ borderColor: "rgba(200, 164, 78, 0.25)" }}
    >
      <img
        src={src}
        alt={caption}
        loading="lazy"
        className="block w-full h-auto"
        data-testid="screenshot-image"
      />
      <figcaption
        className="text-xs px-3 py-2"
        style={{
          background: "rgba(200, 164, 78, 0.08)",
          color: "var(--text-secondary)",
        }}
      >
        {caption}
      </figcaption>
    </figure>
  );
}

function SopHub() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center gap-3 mb-2">
        <LifeBuoy style={{ width: 28, height: 28, color: "var(--gold)" }} />
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ fontFamily: "Rajdhani, sans-serif", color: "var(--text)" }}
          data-testid="text-helpcenter-title"
        >
          Help Center
        </h1>
      </div>
      <p className="text-base mb-8" style={{ color: "var(--text-secondary)" }}>
        Step-by-step SOPs for the team. Pick a topic to get started.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SOPS.map((sop) => {
          const Icon = sop.icon;
          return (
            <Link
              key={sop.slug}
              href={`/help-center/${sop.slug}`}
              data-testid={`card-sop-${sop.slug}`}
              className="block rounded-lg border p-5 transition-colors group"
              style={{
                borderColor: "rgba(200, 164, 78, 0.25)",
                background: "var(--bg-card)",
              }}
            >
              <div className="flex items-start gap-4">
                <div
                  className="rounded-md p-2 flex-shrink-0"
                  style={{ background: "rgba(200, 164, 78, 0.12)" }}
                >
                  <Icon style={{ width: 22, height: 22, color: "var(--gold)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2
                      className="text-lg font-semibold mb-1"
                      style={{ fontFamily: "Rajdhani, sans-serif", color: "var(--text)" }}
                    >
                      {sop.title}
                    </h2>
                    <span
                      className="text-xs whitespace-nowrap"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {sop.estimatedReadMin} min
                    </span>
                  </div>
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    {sop.description}
                  </p>
                </div>
                <ChevronRight
                  style={{ width: 18, height: 18, color: "var(--text-muted)" }}
                  className="flex-shrink-0 mt-1 group-hover:translate-x-1 transition-transform"
                />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function SopDetail({ sop }: { sop: Sop }) {
  const Icon = sop.icon;
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <Link
        href="/help-center"
        data-testid="link-back-to-helpcenter"
        className="inline-flex items-center gap-1.5 text-sm mb-6 hover:opacity-80"
        style={{ color: "var(--gold)" }}
      >
        <ArrowLeft style={{ width: 14, height: 14 }} />
        Back to Help Center
      </Link>

      <div className="flex items-center gap-3 mb-1">
        <Icon style={{ width: 26, height: 26, color: "var(--gold)" }} />
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ fontFamily: "Rajdhani, sans-serif", color: "var(--text)" }}
          data-testid={`text-sop-title-${sop.slug}`}
        >
          {sop.title}
        </h1>
      </div>
      <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
        Estimated read: {sop.estimatedReadMin} min
      </p>

      <div
        className="rounded-md border p-5 mb-8"
        style={{
          borderColor: "rgba(200, 164, 78, 0.25)",
          background: "rgba(200, 164, 78, 0.05)",
        }}
      >
        <p className="text-base mb-3" style={{ color: "var(--text)" }}>
          {sop.intro}
        </p>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          <span style={{ color: "var(--gold)", fontWeight: 600 }}>Who this is for:</span>{" "}
          {sop.whoFor}
        </p>
      </div>

      {sop.sections.map((section, sIdx) => (
        <section key={sIdx} className="mb-10">
          <h2
            className="text-xl font-semibold mb-4 pb-2 border-b"
            style={{
              fontFamily: "Rajdhani, sans-serif",
              color: "var(--text)",
              borderColor: "rgba(200, 164, 78, 0.25)",
            }}
          >
            {section.heading}
          </h2>
          <ol className="space-y-5">
            {section.steps.map((step, stIdx) => (
              <li key={stIdx} className="flex gap-4">
                <div
                  className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm font-semibold"
                  style={{
                    background: "rgba(200, 164, 78, 0.15)",
                    color: "var(--gold)",
                  }}
                >
                  {stIdx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <h3
                    className="text-base font-semibold mb-1.5"
                    style={{ color: "var(--text)" }}
                  >
                    {step.title}
                  </h3>
                  {Array.isArray(step.body) ? (
                    <div className="space-y-1.5">
                      {step.body.map((line, i) => (
                        <p
                          key={i}
                          className="text-sm leading-relaxed"
                          style={{ color: "var(--text-dim)" }}
                        >
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p
                      className="text-sm leading-relaxed"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {step.body}
                    </p>
                  )}
                  {step.image ? (
                    <ScreenshotImage src={step.image} caption={step.screenshot ?? step.title} />
                  ) : step.screenshot ? (
                    <ScreenshotPlaceholder caption={step.screenshot} />
                  ) : null}
                  {step.tip && (
                    <div
                      className="mt-2 rounded-md px-3 py-2 text-sm"
                      style={{
                        background: "rgba(200, 164, 78, 0.08)",
                        borderLeft: "3px solid var(--gold)",
                        color: "var(--text)",
                      }}
                    >
                      <span style={{ color: "var(--gold)", fontWeight: 600 }}>Tip:</span>{" "}
                      {step.tip}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      <div
        className="rounded-md border p-4 text-sm"
        style={{
          borderColor: "var(--border-ds)",
          background: "var(--bg-card)",
          color: "var(--text-muted)",
        }}
      >
        Found something out of date or unclear? Send a note to your admin so this SOP can
        be fixed.
      </div>
    </div>
  );
}

export default function HelpCenterPage() {
  const [, params] = useRoute<{ sop: string }>("/help-center/:sop");
  const slug = params?.sop;

  const sop = useMemo(() => SOPS.find((s) => s.slug === slug), [slug]);

  if (slug && !sop) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h1 className="text-2xl mb-4" style={{ color: "var(--text)" }}>
          SOP not found
        </h1>
        <Link
          href="/help-center"
          className="inline-flex items-center gap-1.5 text-sm"
          style={{ color: "var(--gold)" }}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} />
          Back to Help Center
        </Link>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--bg-page)", minHeight: "calc(100vh - 64px)" }}>
      {sop ? <SopDetail sop={sop} /> : <SopHub />}
    </div>
  );
}

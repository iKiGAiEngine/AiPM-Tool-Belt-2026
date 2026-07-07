import { db } from "../server/db";
import { users } from "../shared/schema";
import { getValidToken } from "../server/autodesk/tokenManager";
import { eq } from "drizzle-orm";

async function main() {
  const adminUsers = await db.select().from(users).where(eq(users.role, "admin"));
  if (adminUsers.length === 0) { console.log("No admin users"); process.exit(1); }
  const userId = adminUsers[0].id;
  const token = await getValidToken(userId);
  if (!token) { console.log("No valid BC token for admin"); process.exit(1); }

  const targets = ["69ea71223a993b003bee23a7","69e6a16a707ba0a1ab0ad7fb","69ea5a0c65d81b38cca00eb3","69e6a16a707ba0a1ab0ad7fb"];

  const endpoints = [
    "https://developer.api.autodesk.com/buildingconnected/v2/bid-board/opportunities?page[limit]=50",
    "https://developer.api.autodesk.com/construction/buildingconnected/v2/opportunities?limit=50",
  ];

  for (const url of endpoints) {
    console.log("\n=====", url);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    console.log("status", res.status);
    if (!res.ok) { console.log((await res.text()).slice(0,300)); continue; }
    const data = await res.json() as any;
    const arr: any[] = data.results || data.data || [];
    console.log("count", arr.length);
    if (arr.length === 0) continue;
    const match = arr.find(o => targets.includes(o.id || o._id)) || arr[0];
    console.log("Sampling opportunity id:", match.id || match._id);
    console.log("Top-level keys:", Object.keys(match));
    const probe: Record<string, any> = {};
    function walk(obj: any, path: string, depth: number) {
      if (obj == null || typeof obj !== "object" || depth > 4) return;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const p = path ? `${path}.${k}` : k;
        if (/start|finish|end|date|completion|expected|estimated|sched/i.test(k)) {
          if (typeof v !== "object" || v == null) probe[p] = v;
          else if (Array.isArray(v)) probe[p] = `<array len=${v.length}>`;
          else probe[p] = `<obj keys:${Object.keys(v).join(",")}>`;
        }
        if (typeof v === "object" && v !== null && !Array.isArray(v)) walk(v, p, depth + 1);
      }
    }
    walk(match, "", 0);
    console.log("Date-related fields:");
    console.log(JSON.stringify(probe, null, 2));
    if (match.project) console.log("project keys:", Object.keys(match.project), "\nproject sample:", JSON.stringify(match.project).slice(0, 1500));
    console.log("---- raw sample (first 2000 chars) ----");
    console.log(JSON.stringify(match).slice(0, 2000));
  }

  // Probe GET-by-id endpoints (used by the email-intake BC reference pull).
  // Grabs a real opportunity id from the list endpoints above, then verifies
  // the single-opportunity fetch works on each API base and shows how the
  // payload is nested (bare object vs { data: ... }).
  let sampleId = "";
  for (const url of endpoints) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const data = await res.json() as any;
    const arr: any[] = data.results || data.data || [];
    if (arr.length > 0) { sampleId = arr[0].id || arr[0]._id; break; }
  }
  if (!sampleId) {
    console.log("\nNo opportunity id available to probe GET-by-id endpoints");
  } else {
    const byIdEndpoints = [
      `https://developer.api.autodesk.com/buildingconnected/v2/bid-board/opportunities/${sampleId}`,
      `https://developer.api.autodesk.com/construction/buildingconnected/v2/opportunities/${sampleId}`,
    ];
    for (const url of byIdEndpoints) {
      console.log("\n===== GET-by-id:", url);
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        console.log("status", res.status);
        const text = await res.text();
        if (!res.ok) { console.log(text.slice(0, 300)); continue; }
        const data = JSON.parse(text) as any;
        console.log("Top-level keys:", Object.keys(data));
        const opp = data.data && !Array.isArray(data.data) ? data.data : data;
        console.log("Opportunity keys:", Object.keys(opp));
        console.log("id:", opp.id || opp._id, "| name:", opp.name || opp.projectName || opp.attributes?.name);
        console.log("---- raw (first 2000 chars) ----");
        console.log(text.slice(0, 2000));
      } catch (err: any) {
        console.log("fetch error:", err.message);
      }
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

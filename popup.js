const termsUrlEl = document.getElementById("termsUrl");
const privacyUrlEl = document.getElementById("privacyUrl");
const scanBtn = document.getElementById("scan");
const downloadReportBtn = document.getElementById("downloadReport");
const termsItemEl = document.getElementById("termsItem");
const privacyItemEl = document.getElementById("privacyItem");
const termsLinkEl = document.getElementById("termsLink");
const privacyLinkEl = document.getElementById("privacyLink");
const lastScanBadgeEl = document.getElementById("lastScanBadge");
const linksSectionEl = document.getElementById("linksSection");
const downloadSectionEl = document.getElementById("downloadSection");
const resultsCardEl = document.getElementById("resultsCard");
const linksCardEl = document.getElementById("linksCard");
const overallStatusEl = document.getElementById("overallStatus");
const nextStepsLineEl = document.getElementById("nextStepsLine");

const outputEl = document.getElementById("output");
let storedApiKey = "";
let storedSkillId = "";
let lastResults = [];

function setDownloadVisible(visible) {
  if (!downloadSectionEl || !downloadReportBtn) return;
  downloadSectionEl.className = visible ? "stack" : "stack hidden";
  downloadReportBtn.disabled = !visible;
}

function setResultsVisible(visible) {
  if (!resultsCardEl) return;
  resultsCardEl.className = visible ? "card" : "card hidden";
  if (linksCardEl) linksCardEl.className = visible ? "card hidden" : "card";
  if (scanBtn) scanBtn.classList.toggle("hidden", visible);
}

function setScannedState(scanned) {
  document.body.classList.toggle("scanned", scanned);
  scanBtn.textContent = scanned ? "Scan again" : "Scan";
}

function setScanLabel(text, resetDelayMs, resetText) {
  scanBtn.textContent = text;
  if (resetDelayMs) {
    setTimeout(() => {
      scanBtn.textContent = resetText || "Scan again";
    }, resetDelayMs);
  }
}

function setScanningState(scanning) {
  if (!scanBtn) return;
  scanBtn.className = scanning ? "primary-btn scanning" : "primary-btn";
  scanBtn.setAttribute("aria-busy", scanning ? "true" : "false");
}

function escapeHtml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateDetectedVisibility() {
  const hasTerms = Boolean(termsUrlEl.value.trim());
  const hasPrivacy = Boolean(privacyUrlEl.value.trim());
  if (termsItemEl) termsItemEl.className = hasTerms ? "" : "hidden";
  if (privacyItemEl) privacyItemEl.className = hasPrivacy ? "" : "hidden";
  if (termsLinkEl && hasTerms) termsLinkEl.href = termsUrlEl.value.trim();
  if (privacyLinkEl && hasPrivacy) privacyLinkEl.href = privacyUrlEl.value.trim();
  const hasAny = hasTerms || hasPrivacy;
  if (linksSectionEl) {
    linksSectionEl.className = hasAny ? "links-section" : "links-section hidden";
  }
  scanBtn.disabled = !hasAny;
  if (!hasAny) {
    setScanLabel("No Terms & Conditions or Privacy Policy detected");
  } else {
    if (!document.body.classList.contains("scanned")) {
      setScanLabel("Scan");
    }
  }
}

function updateLastScanBadge(results) {
  if (!lastScanBadgeEl) return;
  const risks = results
    .map(item => pickWorstRisk(normalizeResponse(item.data)?.summary))
    .map(r => String(r || "").toLowerCase());
  const hasHigh = risks.includes("high");
  const hasMedium = risks.includes("medium");
  if (hasHigh || hasMedium) {
    const level = hasHigh ? "High" : "Medium";
    lastScanBadgeEl.textContent = `Last scan: ${level} risk`;
    lastScanBadgeEl.className = "muted";
  } else {
    lastScanBadgeEl.textContent = "";
    lastScanBadgeEl.className = "muted hidden";
  }
}

async function loadSaved() {
  const saved = await chrome.storage.local.get([
    "apiKey",
    "skillId",
    "detectedByHost",
    "reportByHost"
  ]);
  if (saved.apiKey) storedApiKey = saved.apiKey;
  if (saved.skillId) storedSkillId = saved.skillId;

  const activeHost = await getActiveHost();
  if (activeHost && saved.detectedByHost && typeof saved.detectedByHost === "object") {
    const entry = saved.detectedByHost[activeHost];
    if (entry?.termsUrl) termsUrlEl.value = entry.termsUrl;
    if (entry?.privacyUrl) privacyUrlEl.value = entry.privacyUrl;
  }
  updateDetectedVisibility();

  if (activeHost && saved.reportByHost && typeof saved.reportByHost === "object") {
    const report = saved.reportByHost[activeHost];
    if (report?.results?.length) {
      renderSavedReport(report.results);
    }
  }

  await hydrateDetectedLinks();
}

async function hydrateDetectedLinks() {
  if (termsUrlEl.value || privacyUrlEl.value) return;

  const detected = await detectLinksFromActiveTab();
  if (detected?.termsUrl || detected?.privacyUrl) {
    if (detected.termsUrl) termsUrlEl.value = detected.termsUrl;
    if (detected.privacyUrl) privacyUrlEl.value = detected.privacyUrl;
    if (detected.host) {
      const stored = await chrome.storage.local.get(["detectedByHost"]);
      const detectedByHost = stored.detectedByHost && typeof stored.detectedByHost === "object"
        ? stored.detectedByHost
        : {};
      detectedByHost[detected.host] = {
        termsUrl: detected.termsUrl || "",
        privacyUrl: detected.privacyUrl || ""
      };
      await chrome.storage.local.set({ detectedByHost });
    }
    updateDetectedVisibility();
  } else {
    updateDetectedVisibility();
  }
}

async function getActiveHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return "";
    const url = new URL(tab.url);
    return url.hostname;
  } catch (e) {
    return "";
  }
}

async function detectLinksFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const getText = a => {
          const parts = [a.innerText, a.getAttribute("aria-label"), a.getAttribute("title")]
            .filter(Boolean)
            .map(s => String(s).trim());
          return parts.join(" ").toLowerCase();
        };

        const keywords = [
          "terms",
          "terms of service",
          "tos",
          "legal",
          "agreement",
          "privacy",
          "privacy policy",
          "privacy notice",
          "policy"
        ];

        const links = Array.from(document.querySelectorAll("a[href]"))
          .map(a => ({
            text: getText(a),
            href: a.href
          }))
          .filter(x =>
            x.href && keywords.some(k => x.text.includes(k) || x.href.toLowerCase().includes(k))
          );

        const termsFirst = links.find(l => l.text.includes("terms") || l.href.toLowerCase().includes("terms"));
        const privacyFirst = links.find(l => l.text.includes("privacy") || l.href.toLowerCase().includes("privacy"));
        return {
          termsUrl: termsFirst?.href || "",
          privacyUrl: privacyFirst?.href || "",
          host: location.hostname
        };
      }
    });

    return result || null;
  } catch (e) {
    return null;
  }
}

function renderSavedReport(results) {
  setResultsVisible(true);
  outputEl.innerHTML = "";
  lastResults = results;
  for (const item of results) {
    outputEl.innerHTML += renderOutput(item.data, item.label);
  }
  updateLastScanBadge(results);
  setOverallStatus(results);
  setDownloadVisible(true);
  setScannedState(true);
  setScanLabel("Scan again");
}

// Executes your Browser Use Skill with input schema: { url: string }
async function executeSkill({ apiKey, skillId, url }) {
  const endpoint = `https://api.browser-use.com/api/v2/skills/${skillId}/execute`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey
    },
    body: JSON.stringify({
      parameters: { url }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  return await res.json();
}

function pickWorstRisk(summary) {
  // summary.overall_risk_level is available per your output schema
  return summary?.overall_risk_level || "Unknown";
}

function normalizeResponse(payload) {
  if (payload?.result?.data) return payload.result.data;
  if (payload?.data) return payload.data;
  return payload || {};
}

function getQuickFindings(data) {
  const findings = [];
  if (data.hidden_fees?.detected === false) findings.push("No hidden fees detected");
  if (data.third_party_sharing?.detected === false) findings.push("No privacy leak detected");
  if (data.cancellation_policy?.detected === false) findings.push("No strict cancellation detected");
  return findings;
}

function renderOutput(payload, label) {
  // Expected data fields:
  // url, title, document_length, auto_renewal, cancellation_policy, hidden_fees, third_party_sharing, summary

  const data = normalizeResponse(payload);
  const docUrl = data.url || "";
  const title = data.title || "Document";
  const overall = pickWorstRisk(data.summary);
  const overallLower = String(overall || "").toLowerCase();
  const overallLabel = overallLower
    ? overallLower.charAt(0).toUpperCase() + overallLower.slice(1)
    : "Unknown";
  const pillClass = overallLower === "high"
    ? "pill pill-high"
    : overallLower === "medium"
      ? "pill pill-medium"
      : overallLower === "none"
        ? "pill pill-none"
        : "pill";

  const warnings = Array.isArray(data.summary?.warnings) ? data.summary.warnings : [];
  const quickFindings = getQuickFindings(data);
  const warningsHtml = warnings.slice(0, 5).map(x => `<li>${escapeHtml(x)}</li>`).join("");
  const titleHtml = docUrl
    ? `<a href="${escapeHtml(docUrl)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
    : escapeHtml(title);

  return `
    <div class="result-card">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
        <b>${titleHtml}</b>
        <span class="${pillClass}">${escapeHtml(overallLabel)}</span>
      </div>
      ${quickFindings.length ? `<div style="margin-top:10px;"><b>Quick findings</b><ul>${quickFindings.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : ""}
      ${warnings.length ? `<div style="margin-top:10px;"><b>Warnings</b><ul>${warningsHtml}</ul></div>` : ""}
      <div class="muted" style="margin-top:10px;">Not legal advice. This is a risk scan.</div>
    </div>
  `;
}

function setOverallStatus(results) {
  if (!overallStatusEl || !nextStepsLineEl) return;
  const risks = results
    .map(item => pickWorstRisk(normalizeResponse(item.data)?.summary))
    .map(r => String(r || "").toLowerCase());
  let level = "unknown";
  if (risks.includes("high")) level = "high";
  else if (risks.includes("medium")) level = "medium";
  else if (risks.includes("none")) level = "none";
  else if (risks.includes("low")) level = "low";

  overallStatusEl.className = `primary-btn overall-btn overall-${level}`;
  const label = level.charAt(0).toUpperCase() + level.slice(1);
  overallStatusEl.textContent = `Overall: ${label}`;

  if (level === "high") {
    nextStepsLineEl.textContent = "Review flagged clauses before accepting. Consider alternatives.";
  } else if (level === "medium") {
    nextStepsLineEl.textContent = "Review flagged sections and decide if the trade-offs are acceptable.";
  } else {
    nextStepsLineEl.textContent = "Proceed if acceptable and keep a copy for your records.";
  }
}

function buildReportHtml() {
  const timestamp = new Date().toLocaleString();
  const sections = lastResults
    .map(result => {
      const data = normalizeResponse(result.data);
      const summary = data.summary || {};
      const quickFindings = getQuickFindings(data);
      const concerns = Array.isArray(summary.concerns) ? summary.concerns : [];
      const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
      const recommendation = summary.recommendation || "";
      const overall = pickWorstRisk(summary);
      const url = data.url || "";
      const title = data.title || result.label || "Document";

      const quickHtml = quickFindings.length
        ? `<ul>${quickFindings.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
        : "<div>None</div>";

      const concernsHtml = concerns.length
        ? `<ul>${concerns.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
        : "<div>None</div>";

      const warningsHtml = warnings.length
        ? `<ul>${warnings.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
        : "<div>None</div>";

      return `
        <section class="section">
          <div class="section-title">${escapeHtml(result.label || "Report")}</div>
          <div><strong>Title:</strong> ${escapeHtml(title)}</div>
          <div><strong>URL:</strong> ${url ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : ""}</div>
          <div><strong>Overall risk:</strong> ${escapeHtml(overall)}</div>
          ${recommendation ? `<div><strong>Recommendation:</strong> ${escapeHtml(recommendation)}</div>` : ""}
          <div><strong>Quick findings:</strong> ${quickHtml}</div>
          <div><strong>Concerns:</strong> ${concernsHtml}</div>
          <div><strong>Warnings:</strong> ${warningsHtml}</div>
        </section>
      `;
    })
    .join("");

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Terms Risk Scanner Report</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
      h1 { font-size: 18px; margin-bottom: 6px; }
      .meta { font-size: 12px; color: #555; margin-bottom: 16px; }
      .section { border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px; margin-bottom: 14px; }
      .section-title { font-weight: 600; margin-bottom: 6px; }
      ul { margin: 6px 0 0 18px; }
      a { color: #0b57d0; }
    </style>
  </head>
  <body>
    <h1>Terms Risk Scanner Report</h1>
    <div class="meta">Generated: ${escapeHtml(timestamp)}</div>
    ${sections}
    <div class="meta">Not legal advice. This is a risk scan.</div>
  </body>
</html>
  `.trim();
}

downloadReportBtn.addEventListener("click", async () => {
  if (!lastResults.length) return;
  const html = buildReportHtml();
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const filename = `terms-scan-report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});

scanBtn.addEventListener("click", async () => {
  const apiKey = storedApiKey;
  const skillId = storedSkillId;
  const termsUrl = termsUrlEl.value.trim();
  const privacyUrl = privacyUrlEl.value.trim();
  const activeHost = await getActiveHost();

  if (!apiKey || !skillId) {
    setScanLabel("Not configured", 1200, "Scan");
    return;
  }

  const targets = [];
  if (termsUrl) targets.push({ label: "Terms & Conditions", url: termsUrl });
  if (privacyUrl) targets.push({ label: "Privacy Policy", url: privacyUrl });

  if (!targets.length) {
    setScanLabel("No links detected", 1200, "Scan");
    return;
  }

  outputEl.innerHTML = "";
  lastResults = [];
  setDownloadVisible(false);
  setScannedState(false);
  setResultsVisible(false);
  scanBtn.disabled = true;
  setScanningState(true);
  setScanLabel("Scanning...");

  try {
    for (const target of targets) {
      const data = await executeSkill({ apiKey, skillId, url: target.url });
      console.log("Browser Use skill response:", data);
      const normalized = normalizeResponse(data);
      const scanUrl = normalized.url || target.url;
      const overall = pickWorstRisk(normalized.summary);
      await chrome.storage.local.set({
        lastScan: {
          url: scanUrl,
          overall_risk_level: overall,
          updatedAt: Date.now()
        }
      });
      lastResults.push({ label: target.label, data });
      outputEl.innerHTML += renderOutput(data, target.label);
    }
    updateLastScanBadge(lastResults);
    setOverallStatus(lastResults);
    if (activeHost) {
      const stored = await chrome.storage.local.get(["reportByHost"]);
      const reportByHost = stored.reportByHost && typeof stored.reportByHost === "object"
        ? stored.reportByHost
        : {};
      reportByHost[activeHost] = {
        results: lastResults,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ reportByHost });
    }
    const hasResults = lastResults.length > 0;
    setResultsVisible(hasResults);
    setDownloadVisible(hasResults);
    setScannedState(hasResults);
    scanBtn.disabled = false;
    setScanningState(false);
    setScanLabel("Done", 700);
  } catch (err) {
    scanBtn.disabled = false;
    setScanningState(false);
    setScanLabel("Error", 1200);
    outputEl.innerHTML = `<div class="result-card"><b>Scan failed:</b><div class="quote">${escapeHtml(String(err))}</div></div>`;
  }
});

loadSaved();

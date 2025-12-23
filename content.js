// Content script: detect likely Terms/Privacy links and show a banner.
(function () {
  const BANNER_ID = "terms-scanner-banner";
  let observer = null;

  function extractText(a) {
    const parts = [a.innerText, a.getAttribute("aria-label"), a.getAttribute("title")]
      .filter(Boolean)
      .map(s => String(s).trim());
    return parts.join(" ").toLowerCase();
  }

  function findLikelyLinks() {
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
        text: extractText(a),
        href: a.href
      }))
      .filter(x =>
        x.href && keywords.some(k => x.text.includes(k) || x.href.toLowerCase().includes(k))
      );

    const termsFirst = links.find(l => l.text.includes("terms") || l.href.toLowerCase().includes("terms"));
    const privacyFirst = links.find(l => l.text.includes("privacy") || l.href.toLowerCase().includes("privacy"));
    return {
      termsUrl: termsFirst?.href || "",
      privacyUrl: privacyFirst?.href || ""
    };
  }

  function ensureBanner(termsUrl, privacyUrl, lastScan, host) {
    if (!termsUrl && !privacyUrl) return;
    if (document.getElementById(BANNER_ID)) return;

    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.style.position = "fixed";
    banner.style.right = "12px";
    banner.style.top = "12px";
    banner.style.zIndex = "2147483647";
    banner.style.background = "#ffffff";
    banner.style.color = "#1b1b1b";
    banner.style.border = "1px solid #eadfd3";
    banner.style.borderRadius = "12px";
    banner.style.boxShadow = "0 8px 24px rgba(0,0,0,0.08)";
    banner.style.padding = "12px 14px";
    banner.style.fontFamily = "Tahoma, Verdana, sans-serif";
    banner.style.fontSize = "12px";
    banner.style.maxWidth = "280px";
    banner.style.transition = "opacity 220ms ease, transform 220ms ease";
    banner.style.opacity = "0";
    banner.style.transform = "translateY(-4px)";

    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.style.marginBottom = "4px";
    const detectedLabels = [];
    if (termsUrl) detectedLabels.push("Terms & Conditions");
    if (privacyUrl) detectedLabels.push("Privacy Policy");
    title.textContent = `Detected: ${detectedLabels.join(", ")}`;

    const body = document.createElement("div");
    body.textContent = "Run a quick risk scan in the extension.";

    banner.appendChild(title);
    banner.appendChild(body);
    document.documentElement.appendChild(banner);

    requestAnimationFrame(() => {
      banner.style.opacity = "1";
      banner.style.transform = "translateY(0)";
    });

    setTimeout(() => {
      if (!banner.isConnected) return;
      banner.style.opacity = "0";
      banner.style.transform = "translateY(-4px)";
      setTimeout(() => {
        if (banner.isConnected) banner.remove();
      }, 240);
    }, 4000);
  }

  async function scanAndUpdate() {
    const { termsUrl, privacyUrl } = findLikelyLinks();
    if (!termsUrl && !privacyUrl) return false;

    const host = location.hostname;
    const stored = await chrome.storage.local.get(["detectedByHost", "suppressedHosts", "lastScan", "seenHosts"]);
    const detectedByHost = stored.detectedByHost && typeof stored.detectedByHost === "object"
      ? stored.detectedByHost
      : {};
    detectedByHost[host] = { termsUrl, privacyUrl };
    await chrome.storage.local.set({ detectedByHost }).catch(() => {});

    const suppressed = Array.isArray(stored.suppressedHosts) ? stored.suppressedHosts : [];
    const seenHosts = Array.isArray(stored.seenHosts) ? stored.seenHosts : [];
    const isGoogleSearch =
      host.includes("google.") &&
      (location.pathname.startsWith("/search") || location.search.includes("q="));

    if (!suppressed.includes(host) && !seenHosts.includes(host) && !isGoogleSearch) {
      ensureBanner(termsUrl, privacyUrl, stored.lastScan, host);
      seenHosts.push(host);
      await chrome.storage.local.set({ seenHosts }).catch(() => {});
    }

    if (observer) {
      observer.disconnect();
      observer = null;
    }
    return true;
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      scanAndUpdate();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function run() {
    const found = await scanAndUpdate();
    if (!found) {
      startObserver();
      setTimeout(() => {
        scanAndUpdate();
      }, 2000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();

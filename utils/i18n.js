// utils/i18n.js
//
// Tiny server-side translator. Consumers pass a message key and a locale
// (usually from user.language / student.language); missing translations
// fall back to English rather than throwing so a new locale never
// blocks an email or API response.
//
// Deliberately dependency-free — no i18next on the backend, no runtime
// loader. Add a new locale by adding an entry to `catalog` below.
//
// Usage:
//   import { t } from "../utils/i18n.js";
//   const subject = t("email.testCompleted.subject", locale, { title: testTitle });

const catalog = {
  en: {
    "email.testCompleted.subject": "Test completed: {{title}}",
    "email.testCompleted.body":
      "{{studentName}} has finished the test \"{{title}}\" ({{count}} questions). Detailed feedback will be available once the test window closes.",
    "email.fullscreenAlert.subject":
      "Focus Alert: {{studentName}} left fullscreen during a test",
    "error.planLimit": "Plan limit reached for {{dimension}}",
    "error.featureNotIncluded": "Feature not included in your plan",
  },
  hi: {
    "email.testCompleted.subject": "टेस्ट पूर्ण: {{title}}",
    "email.fullscreenAlert.subject":
      "फ़ोकस चेतावनी: {{studentName}} ने टेस्ट के दौरान फ़ुलस्क्रीन छोड़ी",
  },
  es: {
    "email.testCompleted.subject": "Prueba completada: {{title}}",
    "email.fullscreenAlert.subject":
      "Alerta de foco: {{studentName}} salió de pantalla completa durante una prueba",
  },
  fr: {
    "email.testCompleted.subject": "Test terminé : {{title}}",
    "email.fullscreenAlert.subject":
      "Alerte d'attention : {{studentName}} a quitté le plein écran pendant un test",
  },
  zh: {
    "email.testCompleted.subject": "测试完成：{{title}}",
    "email.fullscreenAlert.subject":
      "专注提醒：{{studentName}} 在测试期间退出了全屏",
  },
};

// Simple {{var}} interpolation — no need for a full templating engine
// since values are already sanitized before being handed to the mailer.
function interpolate(str, vars) {
  if (!vars) return str;
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    vars[k] != null ? String(vars[k]) : ""
  );
}

export function t(key, locale = "en", vars) {
  const lang = String(locale || "en").toLowerCase().slice(0, 2);
  const fromLang = catalog[lang]?.[key];
  const fromEn = catalog.en[key];
  const str = fromLang || fromEn || key;
  return interpolate(str, vars);
}

export function supportedLocales() {
  return Object.keys(catalog);
}

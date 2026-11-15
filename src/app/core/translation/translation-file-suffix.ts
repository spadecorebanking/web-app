/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Builds the file suffix for translation requests, with a cache-busting query
 * string, for example `.json?v=261115-g719de6d6a`.
 *
 * Why: translation files keep the same URL on every deploy
 * (`/assets/translations/en-US.json`), and the default nginx image sends no
 * Cache-Control header for them. Browsers then reuse an old copy for as long
 * as their caching heuristic allows, which can be days. After a deploy that
 * adds keys, the new screens show raw keys such as
 * `labels.buttons.Screen All` or `AccountManagement.Title`. The app fetches
 * these files after the page has loaded, so a hard refresh does not reliably
 * fix it either. Adding the build version to the URL gives each deploy its own
 * URL, so every browser downloads the new file once.
 *
 * `version.js` writes both values at build time: `version` is the build date
 * (YYMMDD) and `hash` is the git commit, or `unknown` when git is not
 * available. Empty and `unknown` parts are left out. With nothing usable the
 * plain `.json` suffix is returned, which behaves as before.
 *
 * @param version Build date from `environment.version`.
 * @param hash Git commit from `environment.hash`.
 * @returns The suffix to pass to `TranslateHttpLoader`.
 */
export function translationFileSuffix(version?: string, hash?: string): string {
  const parts = [
    version,
    hash
  ]
    .map((part) => (part ?? '').trim())
    .filter((part) => part && part !== 'unknown');
  return parts.length ? `.json?v=${encodeURIComponent(parts.join('-'))}` : '.json';
}

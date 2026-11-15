/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { translationFileSuffix } from './translation-file-suffix';

describe('translationFileSuffix', () => {
  it('adds the build date and commit as a cache-busting query string', () => {
    expect(translationFileSuffix('261115', 'g719de6d6a')).toBe('.json?v=261115-g719de6d6a');
  });

  it('leaves out an unknown commit but keeps the build date', () => {
    expect(translationFileSuffix('261115', 'unknown')).toBe('.json?v=261115');
  });

  it('falls back to the plain suffix when no build information is available', () => {
    expect(translationFileSuffix(undefined, undefined)).toBe('.json');
    expect(translationFileSuffix(' ', '')).toBe('.json');
  });

  it('encodes characters that are not safe in a query string', () => {
    expect(translationFileSuffix('261115', 'v1.0+dirty build')).toBe('.json?v=261115-v1.0%2Bdirty%20build');
  });
});

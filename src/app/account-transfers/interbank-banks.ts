/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * A bank that can receive an interbank transfer, as shown in the "Bank"
 * dropdown of the interbank transfer form.
 *
 * Keep this shape small. When the bank list API is connected, map its response
 * to this interface in `AccountTransfersService.getInterbankBanks()`, so the
 * form and the transfer payload do not have to change.
 */
export interface InterbankBank {
  /**
   * Identifier of the receiving bank, sent as `to.fspId` in the transfer
   * payload. This is whatever the switch uses to route the payment, for
   * example a CBN bank code or a Mojaloop FSP id.
   */
  id: string;
  /** Name shown to staff in the dropdown and in the transfer summary. */
  name: string;
}

/**
 * Number of digits in a receiving bank account number. Nigerian NUBAN account
 * numbers are always 10 digits. Change this if the form is used in a country
 * with a different account number format.
 */
export const INTERBANK_ACCOUNT_NUMBER_LENGTH = 10;

/**
 * Placeholder bank list, used until the bank list API is connected.
 *
 * The ids are the banks' CBN codes (Access Bank 044, Ecobank 050, GTBank 058),
 * so the payload already has the shape a real list would give. Remove this
 * list when `AccountTransfersService.getInterbankBanks()` calls the API.
 */
export const PLACEHOLDER_INTERBANK_BANKS: readonly InterbankBank[] = [
  { id: '058', name: 'GT Bank' },
  { id: '050', name: 'Eco Bank' },
  { id: '044', name: 'Access Bank' }
];

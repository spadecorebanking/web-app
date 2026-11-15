/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Screening check types exposed on the client Compliance tab.
 *
 * Name and address checks are modelled separately because they ask Yente
 * different questions:
 * - `name` asks "is this client a listed person or company?" and is sent as a
 *   `Person` or `Company` query.
 * - `address` asks "is this address on file linked to a listed entity?" and is
 *   sent as one `Address` query per address on file.
 */
export type ClientScreeningType = 'name' | 'address';

/**
 * UI-ready screening statuses.
 *
 * - `idle`: the operator has not run this check yet.
 * - `loading`: a request to Yente is in flight.
 * - `clear`: Yente returned nothing at or above the possible-match threshold.
 * - `possible-match`: the best candidate scored between the possible-match
 *   threshold and the match threshold; an operator should review it.
 * - `match`: the best candidate scored at or above the match threshold.
 * - `error`: the request failed (network, CORS, Yente error, bad config).
 * - `unavailable`: the check could not run because the client has no usable
 *   data for it (for example, no address on file).
 */
export type ClientScreeningStatus = 'idle' | 'loading' | 'clear' | 'possible-match' | 'match' | 'error' | 'unavailable';

/**
 * Client fields read from the Fineract `GET /clients/{id}` response that the
 * screening service knows how to send to Yente.
 *
 * Only `id` is required. Every other field is optional, and missing values
 * are simply not sent.
 */
export interface ScreenableClient {
  id: number | string;
  displayName?: string;
  firstname?: string;
  middlename?: string;
  lastname?: string;
  fullname?: string;
  /** Person or Entity. Decides whether the name query uses the Person or Company schema. */
  legalForm?: { id?: number; code?: string; value?: string; name?: string };
  /**
   * Fineract returns local dates as `[year, month, day]` arrays. ISO strings
   * are also accepted. For Entity clients Fineract stores the incorporation
   * date in this same field.
   */
  dateOfBirth?: number[] | string;
  /** Gender code value configured by the tenant, for example `{ name: 'Male' }`. */
  gender?: { id?: number; name?: string };
  /** Extra details Fineract keeps for Entity (non-person) clients. */
  clientNonPersonDetails?: { incorpNumber?: string };
}

/**
 * Address entry returned by Fineract `GET /client/{clientId}/addresses`.
 * Only the fields used for screening are modelled here.
 */
export interface ClientAddressRecord {
  addressId?: number;
  addressType?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  street?: string;
  townVillage?: string;
  city?: string;
  stateProvinceName?: string;
  stateProvince?: string;
  countyDistrictName?: string;
  countyDistrict?: string;
  countryName?: string;
  country?: string;
  postalCode?: string;
  isActive?: boolean;
  [key: string]: any;
}

/**
 * One client attribute that was sent to Yente.
 *
 * The tab lists these next to each result so the operator can see exactly what
 * was compared. This matters because birth date, gender and country lower a
 * candidate's score when they disagree, so wrong client data can hide a real
 * match.
 */
export interface ScreenedAttribute {
  /** Translation key of the attribute label, for example `labels.inputs.Date of Birth`. */
  labelKey: string;
  /** Values exactly as sent to Yente. */
  values: string[];
}

/**
 * A listed entity that is linked to a matched address, for example the
 * sanctioned company registered at that address.
 *
 * Address entities in OpenSanctions data carry no risk topics of their own:
 * the risk sits on whoever is linked to the address. Without these links an
 * address hit would only say "this address is in a list" and not why.
 */
export interface ClientScreeningLinkedEntity {
  id: string;
  caption: string;
  schema: string;
  topics: string[];
  datasets: string[];
}

/**
 * One feature that contributed to a candidate's score, taken from the
 * `features` map in the Yente response, for example `person_name_jaro_winkler`.
 * Negative coefficients are applied by Yente itself; only the raw feature
 * scores are returned and shown here.
 */
export interface ClientScreeningFeature {
  name: string;
  score: number;
}

/**
 * A Yente candidate normalized for the UI, so the component does not need to
 * know the Yente response format.
 */
export interface ClientScreeningMatch {
  id: string;
  caption: string;
  schema?: string;
  /** Yente score between 0 and 1. */
  score: number;
  datasets: string[];
  /** FollowTheMoney topics, for example `sanction`, `role.pep` or `crime.terror`. */
  topics: string[];
  countries: string[];
  birthDates: string[];
  addresses: string[];
  /** Links to the source publication (`properties.sourceUrl`), when the list publishes one. */
  sourceUrls: string[];
  /** Features with a non-zero score, highest first. */
  features: ClientScreeningFeature[];
  /**
   * For address checks: the client address that produced this candidate.
   * A client can have several addresses, and each is screened separately.
   */
  matchedClientValue?: string;
  /**
   * For address checks: the listed entities linked to this address. This is
   * `undefined` until the lookup has run, and an empty array when the lookup
   * found nothing.
   */
  linkedEntities?: ClientScreeningLinkedEntity[];
}

/**
 * Normalized result of one screening check, consumed by the Compliance tab.
 */
export interface ClientScreeningResult {
  type: ClientScreeningType;
  status: ClientScreeningStatus;
  /** Candidates at or above the possible-match threshold, highest score first. */
  matches: ClientScreeningMatch[];
  /**
   * Candidates Yente returned below the possible-match threshold. They do not
   * change the status, but the operator can still look at them.
   */
  lowerScoredMatches?: ClientScreeningMatch[];
  /** Human-readable summary of the values screened, for example `Jane Doe | J. Doe`. */
  screenedText?: string;
  /** All client attributes sent with the query. */
  screenedAttributes?: ScreenedAttribute[];
  /** ISO-8601 timestamp of when the response was received. */
  screenedAt?: string;
  /** Translation key of an error or "unavailable" message. */
  errorMessageKey?: string;
}

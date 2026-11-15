/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { HttpBackend, HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from 'environments/environment';
import { Observable, forkJoin, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { LegalFormId } from '../models/legal-form.enum';
import {
  ClientAddressRecord,
  ClientScreeningFeature,
  ClientScreeningLinkedEntity,
  ClientScreeningMatch,
  ClientScreeningResult,
  ClientScreeningType,
  ScreenableClient,
  ScreenedAttribute
} from '../models/client-screening.model';

/**
 * One query in a Yente `/match` request body.
 *
 * Yente expects FollowTheMoney (FtM) "entity examples": a schema name and a
 * map of FtM property names to lists of string values. Yente cleans the
 * values itself, so country names such as "Nigeria" become `ng`.
 */
interface YenteQuery {
  schema: 'Person' | 'Company' | 'Address';
  properties: Record<string, string[]>;
}

/**
 * Maximum number of address candidates whose linked entities are looked up
 * after an address check. Each lookup is one extra GET to Yente, so this
 * keeps the request count bounded when an address matches many records.
 */
const MAX_LINKED_ENTITY_LOOKUPS = 5;

/**
 * Talks to a Yente (OpenSanctions) server to screen the selected client.
 *
 * Nothing is stored by this service. It:
 * 1. builds Yente queries from client data already loaded in the web app
 * 2. calls Yente directly, bypassing the app's HTTP interceptors (see `externalHttp`)
 * 3. normalizes the responses into `ClientScreeningResult` objects for the UI
 *
 * Name check: one `Person` or `Company` query. The name is the main signal.
 * Birth date, gender, country and registration number are sent as
 * qualifiers. Yente lowers a candidate's score when these disagree, which
 * removes most false positives for common names.
 *
 * Address check: one `Address` query per active address, with the
 * address split into FtM address fields. Yente compares these with the
 * address entities in its index (`address_entity_match`). The previous
 * version sent the address as a property of a Person query. Yente scores
 * Person candidates by name, so that query always returned nothing.
 */
@Injectable({
  providedIn: 'root'
})
export class ClientScreeningService {
  private httpBackend = inject(HttpBackend);

  /**
   * HttpClient built on the raw backend, with no interceptors. The app's
   * interceptors add the Fineract base URL, tenant header and Basic/OAuth
   * credentials. Those must never be sent to a third-party screening
   * service, and the URL rewriting would also break the absolute Yente URL.
   */
  private externalHttp = new HttpClient(this.httpBackend);

  /**
   * Whether screening is available in this deployment.
   *
   * Either the explicit `ENABLE_YENTE_SCREENING=true` flag or a non-empty
   * `YENTE_SCREENING_URL` enables it. Some deployments set only the URL, and
   * they still expect the Compliance tab to appear.
   */
  get enabled(): boolean {
    return environment.enableYenteScreening === true || !!environment.yenteScreeningUrl?.trim();
  }

  /** Top score at or above which a result is a `match`. Configured via `YENTE_MATCH_THRESHOLD`. */
  get matchThreshold(): number {
    return this.toThreshold(environment.yenteMatchThreshold, 0.85);
  }

  /** Top score at or above which a result is a `possible-match`. Configured via `YENTE_POSSIBLE_MATCH_THRESHOLD`. */
  get possibleMatchThreshold(): number {
    return this.toThreshold(environment.yentePossibleMatchThreshold, 0.7);
  }

  /**
   * Screens the client's identity (name plus qualifiers) against Yente.
   *
   * @param client Client record from the client view resolver.
   * @param addresses Addresses on file, if already loaded. Used only to add
   *   the country of residence as a qualifier. Pass `[]` when they are not
   *   available. The check still runs, without the country qualifier.
   * @returns The normalized result. Errors with
   *   `errors.clientScreeningMissingName` when the client has no usable name.
   */
  screenClientName(client: ScreenableClient, addresses: ClientAddressRecord[] = []): Observable<ClientScreeningResult> {
    const nameCandidates = this.getNameCandidates(client);
    if (nameCandidates.length === 0) {
      return throwError(() => new Error('errors.clientScreeningMissingName'));
    }

    const isCompany = this.isCompany(client);
    const properties: Record<string, string[]> = { name: nameCandidates };
    const screenedAttributes: ScreenedAttribute[] = [
      { labelKey: 'labels.inputs.Name', values: nameCandidates }
    ];

    // Fineract stores both a person's birth date and an entity's incorporation
    // date in `dateOfBirth`. Yente's dob_year_disjoint and dob_day_disjoint
    // features penalize candidates with a different date.
    const date = this.toIsoDate(client.dateOfBirth);
    if (date) {
      properties[isCompany ? 'incorporationDate' : 'birthDate'] = [date];
      screenedAttributes.push({
        labelKey: isCompany ? 'labels.inputs.Incorporation Date' : 'labels.inputs.Date of Birth',
        values: [date]
      });
    }

    if (!isCompany) {
      const gender = this.toFtmGender(client.gender?.name);
      if (gender) {
        properties['gender'] = [gender];
        screenedAttributes.push({ labelKey: 'labels.inputs.Gender', values: [gender] });
      }
    } else if (client.clientNonPersonDetails?.incorpNumber?.trim()) {
      // A registration number that differs from the candidate's lowers the
      // score (orgid_disjoint); an identical one raises it (identifier_match).
      const registrationNumber = client.clientNonPersonDetails.incorpNumber.trim();
      properties['registrationNumber'] = [registrationNumber];
      screenedAttributes.push({ labelKey: 'labels.inputs.Incorporation Number', values: [registrationNumber] });
    }

    const countries = this.getCountries(addresses);
    if (countries.length) {
      // FtM uses `country` on Person and `jurisdiction` on Company. Both are
      // country-typed, so Yente's country_mismatch check sees either one.
      properties[isCompany ? 'jurisdiction' : 'country'] = countries;
      screenedAttributes.push({ labelKey: 'labels.inputs.Country', values: countries });
    }

    const queryId = `client-name-${client.id}`;
    return this.executeScreening('name', { [queryId]: { schema: isCompany ? 'Company' : 'Person', properties } }).pipe(
      map((responses) =>
        this.buildResult('name', this.normalizeMatches(responses[queryId] ?? []), {
          screenedText: nameCandidates.join(' | '),
          screenedAttributes
        })
      )
    );
  }

  /**
   * Screens every active address of the client against Yente's address
   * entities.
   *
   * All addresses go in one request (one query each). The candidates are
   * merged, de-duplicated by entity id (the highest score wins), and tagged
   * with the client address that produced them. Weak hits on country-only or
   * city-only address records are dropped (see `isSpecificAddressCandidate`).
   *
   * @returns The normalized result. Errors with
   *   `errors.clientScreeningMissingAddress` when no active address has any
   *   screenable text.
   */
  screenClientAddress(client: ScreenableClient, addresses: ClientAddressRecord[]): Observable<ClientScreeningResult> {
    const prepared = (addresses || [])
      .filter((address) => address?.isActive !== false)
      .map((address) => this.toAddressQuery(address))
      .filter((entry): entry is { full: string; query: YenteQuery } => !!entry)
      // Two addresses with identical text would give identical results.
      .filter((entry, index, all) => all.findIndex((other) => other.full === entry.full) === index);

    if (prepared.length === 0) {
      return throwError(() => new Error('errors.clientScreeningMissingAddress'));
    }

    const queries: Record<string, YenteQuery> = {};
    prepared.forEach((entry, index) => {
      queries[`client-address-${client.id}-${index}`] = entry.query;
    });

    return this.executeScreening('address', queries).pipe(
      map((responses) => {
        const byId = new Map<string, ClientScreeningMatch>();
        prepared.forEach((entry, index) => {
          const raw = (responses[`client-address-${client.id}-${index}`] ?? []).filter((candidate) =>
            this.isSpecificAddressCandidate(candidate)
          );
          this.normalizeMatches(raw).forEach((match) => {
            const existing = byId.get(match.id);
            if (!existing || match.score > existing.score) {
              byId.set(match.id, { ...match, matchedClientValue: entry.full });
            }
          });
        });

        return this.buildResult(
          'address',
          [...byId.values()].sort((left, right) => right.score - left.score),
          {
            screenedText: prepared.map((entry) => entry.full).join(' | '),
            screenedAttributes: [
              { labelKey: 'labels.inputs.Addresses', values: prepared.map((entry) => entry.full) }
            ]
          }
        );
      })
    );
  }

  /**
   * Adds the linked listed entities to the top address candidates.
   *
   * Calls `GET {yente}/entities/{id}?nested=true` for each of the first
   * `MAX_LINKED_ENTITY_LOOKUPS` candidates in `result.matches`, and reads the
   * entities that point at the address (`properties.things`). A failed lookup
   * leaves that candidate with an empty `linkedEntities` list and does not
   * fail the screening result.
   *
   * @returns A copy of `result` with `linkedEntities` filled in, or the same
   *   result when there is nothing to enrich.
   */
  enrichAddressMatches(result: ClientScreeningResult): Observable<ClientScreeningResult> {
    if (result.type !== 'address' || result.matches.length === 0) {
      return of(result);
    }

    // Each lookup catches its own errors and always completes, so forkJoin
    // always emits once and one failed lookup cannot block the others.
    const lookups = result.matches.slice(0, MAX_LINKED_ENTITY_LOOKUPS).map((match) => this.getLinkedEntities(match.id));

    return forkJoin(lookups).pipe(
      map((linked) => ({
        ...result,
        matches: result.matches.map((match, index) =>
          index < linked.length ? { ...match, linkedEntities: linked[index] } : match
        )
      }))
    );
  }

  /**
   * Builds the plain-text audit note that the Compliance tab can save to the
   * client's Notes. Fineract notes are plain text, so this uses simple lines.
   * The note records what was screened, when, against which dataset, with
   * which thresholds, and the best candidates.
   *
   * @param results The completed checks to include. Idle and loading results are skipped.
   */
  buildScreeningNote(results: ClientScreeningResult[]): string {
    const lines: string[] = [
      `Sanctions/PEP screening (Yente, dataset "${this.dataset}")`,
      `Thresholds: match >= ${this.matchThreshold}, possible match >= ${this.possibleMatchThreshold}`
    ];

    results
      .filter((result) => result.status !== 'idle' && result.status !== 'loading')
      .forEach((result) => {
        lines.push('');
        lines.push(`${result.type === 'name' ? 'Name' : 'Address'} check: ${result.status.toUpperCase()}`);
        if (result.screenedAt) {
          lines.push(`Screened at: ${result.screenedAt}`);
        }
        (result.screenedAttributes || []).forEach((attribute) => {
          lines.push(`- ${this.noteLabel(attribute.labelKey)}: ${attribute.values.join('; ')}`);
        });
        if (result.matches.length === 0) {
          lines.push('No candidates at or above the possible-match threshold.');
        }
        result.matches.slice(0, 5).forEach((match) => {
          const topics = match.topics.length ? ` [${match.topics.join(', ')}]` : '';
          const linked = match.linkedEntities?.length
            ? ` linked to ${match.linkedEntities.map((entity) => entity.caption).join(', ')}`
            : '';
          lines.push(`* ${match.caption} (${match.id}) score ${match.score.toFixed(2)}${topics}${linked}`);
        });
      });

    return lines.join('\n');
  }

  /** Dataset (collection) queried in Yente, for example `sanctions` or `default`. */
  get dataset(): string {
    return environment.yenteScreeningDataset?.trim() || 'sanctions';
  }

  /**
   * Sends one Yente `/match` request with all the given queries.
   *
   * @returns Each query's raw `results` array, keyed by query id. An empty
   *   array is returned for a query that is missing from the response.
   */
  private executeScreening(
    type: ClientScreeningType,
    queries: Record<string, YenteQuery>
  ): Observable<Record<string, any[]>> {
    let apiUrl = '';
    try {
      apiUrl = `${this.getBaseUrl()}/match/${encodeURIComponent(this.dataset)}`;
    } catch (error) {
      return throwError(() => error);
    }

    return this.externalHttp.post(apiUrl, { queries }).pipe(
      map((response: any) => {
        const out: Record<string, any[]> = {};
        Object.keys(queries).forEach((queryId) => {
          out[queryId] = this.extractRawResults(response, queryId, type);
        });
        return out;
      })
    );
  }

  /**
   * Returns the entities linked to one address, or an empty list when the
   * lookup fails. Fetching only the address's nested graph returns its
   * `things` (the companies or people registered at it) in a single call.
   */
  private getLinkedEntities(entityId: string): Observable<ClientScreeningLinkedEntity[]> {
    let url = '';
    try {
      url = `${this.getBaseUrl()}/entities/${encodeURIComponent(entityId)}?nested=true`;
    } catch {
      return of([]);
    }
    return this.externalHttp.get(url).pipe(
      map((entity: any) =>
        this.asArray(entity?.properties?.things)
          .filter((thing: any) => thing && typeof thing === 'object' && thing.id)
          .map((thing: any) => ({
            id: String(thing.id),
            caption: String(thing.caption ?? thing.id),
            schema: String(thing.schema ?? ''),
            topics: this.asStringArray(thing.properties?.topics),
            datasets: this.asStringArray(thing.datasets)
          }))
      ),
      catchError(() => of([]))
    );
  }

  /**
   * Returns the configured Yente base URL without a trailing slash.
   * Throws `errors.clientScreeningNotConfigured` when it is empty.
   */
  private getBaseUrl(): string {
    const baseUrl = environment.yenteScreeningUrl?.trim();
    if (!baseUrl) {
      throw new Error('errors.clientScreeningNotConfigured');
    }
    return baseUrl.replace(/\/+$/, '');
  }

  /**
   * Extracts one query's `results` array from a Yente batch response.
   *
   * Current Yente versions return `{ responses: { [queryId]: { results } } }`.
   * Older or proxied deployments sometimes return a flat `{ results }`, or use
   * `matches` instead of `results`. A single-query response may also come back
   * under a different key, which is why the name check falls back to the first
   * response.
   */
  private extractRawResults(response: any, queryId: string, type: ClientScreeningType): any[] {
    if (Array.isArray(response?.results)) {
      return response.results;
    }

    const responses = response?.responses || {};
    const keys = Object.keys(responses);
    const queryResponse = responses[queryId] ?? (type === 'name' && keys.length === 1 ? responses[keys[0]] : undefined);

    if (Array.isArray(queryResponse?.results)) {
      return queryResponse.results;
    }
    if (Array.isArray(queryResponse?.matches)) {
      return queryResponse.matches;
    }
    return [];
  }

  /** Maps raw Yente candidates to UI records, sorted by score (highest first). */
  private normalizeMatches(rawResults: any[]): ClientScreeningMatch[] {
    return rawResults
      .map((result) => this.mapMatch(result))
      .filter((result): result is ClientScreeningMatch => !!result)
      .sort((left, right) => right.score - left.score);
  }

  /**
   * Splits the candidates at the possible-match threshold and sets the
   * status from the best score. Lower-scored candidates are still returned
   * so the operator can review near misses.
   */
  private buildResult(
    type: ClientScreeningType,
    candidates: ClientScreeningMatch[],
    extra: Pick<ClientScreeningResult, 'screenedText' | 'screenedAttributes'>
  ): ClientScreeningResult {
    const possible = this.possibleMatchThreshold;
    const matches = candidates.filter((candidate) => candidate.score >= possible);
    const lowerScoredMatches = candidates.filter((candidate) => candidate.score < possible);

    return {
      type,
      matches,
      lowerScoredMatches,
      ...extra,
      screenedAt: new Date().toISOString(),
      status: this.resolveStatus(matches[0]?.score ?? 0, matches.length)
    };
  }

  /**
   * Maps one raw Yente candidate to a `ClientScreeningMatch`.
   * Returns `null` when the candidate has no id or caption.
   */
  private mapMatch(result: any): ClientScreeningMatch | null {
    const properties = result?.properties ?? {};
    const caption = result?.caption ?? result?.name ?? properties?.name?.[0] ?? properties?.full?.[0];
    const id = result?.id ?? result?.entityId ?? caption;

    if (!caption || !id) {
      return null;
    }

    const rawFeatures = result?.features && typeof result.features === 'object' ? result.features : {};
    const features: ClientScreeningFeature[] = Object.entries(rawFeatures)
      .map(
        ([
          name,
          score
        ]) => ({ name, score: Number(score) })
      )
      .filter((feature) => Number.isFinite(feature.score) && feature.score !== 0)
      .sort((left, right) => right.score - left.score);

    return {
      id: String(id),
      caption: String(caption),
      schema: result?.schema ?? '',
      score: Number(result?.score ?? 0) || 0,
      datasets: this.asStringArray(result?.datasets ?? result?.dataset),
      topics: this.asStringArray(properties.topics),
      countries: this.asStringArray(properties.country ?? properties.nationality ?? properties.jurisdiction),
      birthDates: this.asStringArray(properties.birthDate ?? properties.incorporationDate),
      addresses: this.asStringArray(properties.full ?? properties.address),
      // Only `properties.sourceUrl` is a link to the list publication. Fields
      // such as `first_seen` (a date) or `referents` (entity ids) are not.
      sourceUrls: this.asStringArray(properties.sourceUrl).filter((url) => /^https?:\/\//i.test(url)),
      features
    };
  }

  /**
   * Returns false for address candidates that name only a country, region or
   * city, such as the plain "Nigeria" and "Lagos" address records in the
   * OFAC, DFAT and Japan MoF lists. Yente scores them highly against almost
   * any local address: in testing, "Nigeria" scored 0.88 against a Kano
   * street address, above the default match threshold. Without this filter,
   * every Nigerian client would be flagged.
   *
   * A candidate is specific when it has a `street` or `postalCode`, or its
   * text contains a digit (a house or plot number). Candidates that are not
   * `Address` entities are always kept.
   */
  private isSpecificAddressCandidate(candidate: any): boolean {
    if (candidate?.schema && candidate.schema !== 'Address') {
      return true;
    }
    const properties = candidate?.properties ?? {};
    if (this.asStringArray(properties.street).length || this.asStringArray(properties.postalCode).length) {
      return true;
    }
    const text = [
      candidate?.caption,
      ...this.asStringArray(properties.full)
    ].join(' ');
    return /\d/.test(text);
  }

  /**
   * Turns one Fineract address into a Yente `Address` query.
   * Returns `null` when the address has no text at all.
   *
   * `full` carries the whole address because Yente compares it against the
   * candidate's full address. The structured fields are sent as well so that
   * Yente can use them.
   */
  private toAddressQuery(address: ClientAddressRecord): { full: string; query: YenteQuery } | null {
    const street = [
      address.addressLine1,
      address.addressLine2,
      address.addressLine3,
      address.street
    ]
      .map((value) => this.clean(value))
      .filter(Boolean)
      .join(', ');
    const city = this.clean(address.city ?? address.townVillage);
    const region = this.clean(address.stateProvinceName ?? address.stateProvince);
    const district = this.clean(address.countyDistrictName ?? address.countyDistrict);
    const postalCode = this.clean(address.postalCode);
    const country = this.clean(address.countryName ?? address.country);

    const full = [
      street,
      city,
      district,
      region,
      postalCode,
      country
    ]
      .filter(Boolean)
      .join(', ');
    if (!full) {
      return null;
    }

    const properties: Record<string, string[]> = { full: [full] };
    if (street) properties['street'] = [street];
    if (city) properties['city'] = [city];
    if (region) properties['region'] = [region];
    if (postalCode) properties['postalCode'] = [postalCode];
    if (country) properties['country'] = [country];

    return { full, query: { schema: 'Address', properties } };
  }

  /**
   * Converts the top score into a status.
   * No candidates at or above the possible-match threshold means `clear`.
   */
  private resolveStatus(topScore: number, matchCount: number): ClientScreeningResult['status'] {
    if (!matchCount) {
      return 'clear';
    }
    if (topScore >= this.matchThreshold) {
      return 'match';
    }
    return 'possible-match';
  }

  /**
   * Returns the distinct names shown on the client record: display name,
   * first/middle/last name joined, and full name (entity clients).
   * Yente scores each name and keeps the best.
   */
  private getNameCandidates(client: ScreenableClient): string[] {
    return [
      client.displayName,
      [
        client.firstname,
        client.middlename,
        client.lastname
      ]
        .filter(Boolean)
        .join(' '),
      client.fullname
    ]
      .map((value) => this.clean(value))
      .filter((value, index, values): value is string => !!value && values.indexOf(value) === index);
  }

  /** Distinct country names from the active addresses, in the order found. */
  private getCountries(addresses: ClientAddressRecord[]): string[] {
    return (addresses || [])
      .filter((address) => address?.isActive !== false)
      .map((address) => this.clean(address.countryName ?? address.country))
      .filter((value, index, values): value is string => !!value && values.indexOf(value) === index);
  }

  /** Entity clients are screened as `Company`; everyone else as `Person`. */
  private isCompany(client: ScreenableClient): boolean {
    return client?.legalForm?.id === LegalFormId.ENTITY;
  }

  /**
   * Converts a Fineract date (`[yyyy, m, d]` or an ISO string) to
   * `YYYY-MM-DD`. Returns an empty string for anything else, so a malformed
   * date is never sent as a qualifier.
   */
  private toIsoDate(value: number[] | string | undefined): string {
    if (Array.isArray(value) && value.length >= 3 && value.every((part) => Number.isFinite(Number(part)))) {
      const [
        year,
        month,
        day
      ] = value.map(Number);
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value.substring(0, 10);
    }
    return '';
  }

  /**
   * Maps a tenant-configured gender code value to FtM's `male`/`female`.
   * Tenants name these freely ("Male", "M", "Female", "F"...). Any other value
   * is not sent, because a wrong gender would apply Yente's gender_mismatch
   * penalty to real matches.
   */
  private toFtmGender(value: string | undefined): string {
    const normalized = this.clean(value).toLowerCase();
    if ([
        'male',
        'm',
        'man'
      ].includes(normalized)) {
      return 'male';
    }
    if ([
        'female',
        'f',
        'woman'
      ].includes(normalized)) {
      return 'female';
    }
    return '';
  }

  /** English label for a screened attribute in the saved note (notes are not translated). */
  private noteLabel(labelKey: string): string {
    return labelKey.split('.').pop() || labelKey;
  }

  private clean(value: unknown): string {
    return value == null ? '' : String(value).trim();
  }

  private asArray(value: unknown): any[] {
    if (Array.isArray(value)) {
      return value;
    }
    return value == null ? [] : [value];
  }

  private asStringArray(value: unknown): string[] {
    return this.asArray(value)
      .map((item) => (item == null ? '' : String(item)))
      .filter(Boolean);
  }

  private toThreshold(value: string | number | undefined, fallback: number): number {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}

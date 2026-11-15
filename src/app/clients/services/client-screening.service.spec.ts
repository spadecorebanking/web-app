/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { describe, beforeEach, afterEach, expect, it } from '@jest/globals';
import { environment } from 'environments/environment';
import { LegalFormId } from '../models/legal-form.enum';
import { ClientScreeningResult } from '../models/client-screening.model';
import { ClientScreeningService } from './client-screening.service';

/**
 * The service builds Yente queries from client data and normalizes the
 * responses. These tests pin down the request shape (because it decides
 * what Yente can match on) and the classification rules (because they
 * decide what the operator sees).
 */
describe('ClientScreeningService', () => {
  const YENTE = 'https://yente.test';
  const MATCH_URL = `${YENTE}/match/sanctions`;

  let service: ClientScreeningService;
  let httpMock: HttpTestingController;

  const originalEnvironment = {
    enableYenteScreening: environment.enableYenteScreening,
    yenteScreeningUrl: environment.yenteScreeningUrl,
    yenteScreeningDataset: environment.yenteScreeningDataset,
    yenteMatchThreshold: environment.yenteMatchThreshold,
    yentePossibleMatchThreshold: environment.yentePossibleMatchThreshold
  };

  beforeEach(() => {
    environment.enableYenteScreening = true;
    environment.yenteScreeningUrl = `${YENTE}/`;
    environment.yenteScreeningDataset = 'sanctions';
    environment.yenteMatchThreshold = 0.85;
    environment.yentePossibleMatchThreshold = 0.7;

    TestBed.configureTestingModule({
      providers: [
        ClientScreeningService,
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });

    service = TestBed.inject(ClientScreeningService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    Object.assign(environment, originalEnvironment);
  });

  describe('name screening', () => {
    it('sends a Person query with birth date, gender and country qualifiers', async () => {
      const resultPromise = firstValueFrom(
        service.screenClientName(
          {
            id: 11,
            displayName: 'Jane Doe',
            firstname: 'Jane',
            lastname: 'Doe',
            legalForm: { id: LegalFormId.PERSON },
            dateOfBirth: [
              1980,
              3,
              7
            ],
            gender: { name: 'Female' }
          },
          [
            { countryName: 'Nigeria', isActive: true },
            { countryName: 'Ghana', isActive: false }
          ]
        )
      );

      const req = httpMock.expectOne(MATCH_URL);
      expect(req.request.method).toBe('POST');
      const query = req.request.body.queries['client-name-11'];
      expect(query.schema).toBe('Person');
      expect(query.properties).toEqual({
        name: ['Jane Doe'],
        birthDate: ['1980-03-07'],
        gender: ['female'],
        // Inactive addresses must not contribute a country.
        country: ['Nigeria']
      });

      req.flush({
        responses: {
          'client-name-11': {
            results: [
              {
                id: 'nk-abcd',
                caption: 'Jane Doe',
                schema: 'Person',
                score: 0.93,
                datasets: ['us_ofac_sdn'],
                first_seen: '2024-01-01T00:00:00',
                properties: {
                  country: ['ng'],
                  topics: [
                    'sanction',
                    'role.pep'
                  ],
                  birthDate: ['1980-03-07'],
                  sourceUrl: [
                    'https://example.test/entity',
                    'not-a-url'
                  ]
                },
                features: { person_name_jaro_winkler: 1, dob_year_disjoint: 0 }
              }
            ]
          }
        }
      });

      const result = await resultPromise;
      expect(result.status).toBe('match');
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        caption: 'Jane Doe',
        datasets: ['us_ofac_sdn'],
        countries: ['ng'],
        topics: [
          'sanction',
          'role.pep'
        ],
        birthDates: ['1980-03-07'],
        // Only real links are kept; `first_seen` is a date and must not be used as a source.
        sourceUrls: ['https://example.test/entity'],
        // Zero-score features are not useful in the breakdown.
        features: [{ name: 'person_name_jaro_winkler', score: 1 }]
      });
      expect(result.screenedAttributes?.map((attribute) => attribute.labelKey)).toEqual([
        'labels.inputs.Name',
        'labels.inputs.Date of Birth',
        'labels.inputs.Gender',
        'labels.inputs.Country'
      ]);
      expect(result.screenedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('sends a Company query with incorporation date, registration number and jurisdiction', async () => {
      const resultPromise = firstValueFrom(
        service.screenClientName(
          {
            id: 12,
            displayName: 'Acme Ventures',
            fullname: 'Acme Ventures',
            legalForm: { id: LegalFormId.ENTITY },
            dateOfBirth: '2010-05-01',
            gender: { name: 'Male' },
            clientNonPersonDetails: { incorpNumber: ' RC-123 ' }
          },
          [{ country: 'Kenya' }]
        )
      );

      const req = httpMock.expectOne(MATCH_URL);
      const query = req.request.body.queries['client-name-12'];
      expect(query.schema).toBe('Company');
      // Gender never applies to companies.
      expect(query.properties).toEqual({
        name: ['Acme Ventures'],
        incorporationDate: ['2010-05-01'],
        registrationNumber: ['RC-123'],
        jurisdiction: ['Kenya']
      });
      req.flush({ responses: { 'client-name-12': { results: [] } } });

      expect((await resultPromise).status).toBe('clear');
    });

    it('does not send unrecognised genders or malformed dates', async () => {
      const resultPromise = firstValueFrom(
        service.screenClientName({
          id: 14,
          displayName: 'Sam Lee',
          dateOfBirth: [1980] as any,
          gender: { name: 'Prefer not to say' }
        })
      );

      const req = httpMock.expectOne(MATCH_URL);
      expect(req.request.body.queries['client-name-14'].properties).toEqual({ name: ['Sam Lee'] });
      req.flush({ responses: { 'client-name-14': { results: [] } } });
      await resultPromise;
    });

    it('separates possible matches from lower-scored candidates', async () => {
      const resultPromise = firstValueFrom(service.screenClientName({ id: 15, displayName: 'John Smith' }));

      httpMock.expectOne(MATCH_URL).flush({
        responses: {
          'client-name-15': {
            results: [
              { id: 'low', caption: 'Jon Smyth', score: 0.55 },
              { id: 'mid', caption: 'John Smith', score: 0.75 }
            ]
          }
        }
      });

      const result = await resultPromise;
      expect(result.status).toBe('possible-match');
      expect(result.matches.map((match) => match.id)).toEqual(['mid']);
      expect(result.lowerScoredMatches?.map((match) => match.id)).toEqual(['low']);
    });

    it('classifies a response with only lower-scored candidates as clear', async () => {
      const resultPromise = firstValueFrom(service.screenClientName({ id: 16, displayName: 'Acme' }));
      httpMock
        .expectOne(MATCH_URL)
        .flush({ responses: { 'client-name-16': { results: [{ id: 'x', caption: 'Acme Ltd', score: 0.55 }] } } });

      const result = await resultPromise;
      expect(result.status).toBe('clear');
      expect(result.matches).toEqual([]);
      expect(result.lowerScoredMatches).toHaveLength(1);
    });

    it('rejects when the client has no usable name', async () => {
      await expect(firstValueFrom(service.screenClientName({ id: 17, displayName: '  ' }))).rejects.toThrow(
        'errors.clientScreeningMissingName'
      );
    });
  });

  describe('address screening', () => {
    it('sends one Address query per distinct active address', async () => {
      const resultPromise = firstValueFrom(
        service.screenClientAddress({ id: 21 }, [
          {
            addressLine1: '9 Ilyinka Street',
            city: 'Moscow',
            stateProvinceName: 'Moscow Oblast',
            postalCode: '109097',
            countryName: 'Russia'
          },
          // Duplicate of the first address: must not produce a second query.
          {
            addressLine1: '9 Ilyinka Street',
            city: 'Moscow',
            stateProvinceName: 'Moscow Oblast',
            postalCode: '109097',
            countryName: 'Russia'
          },
          { addressLine1: '1 Old Road', city: 'Lagos', isActive: false },
          { city: 'Kano', countryName: 'Nigeria' }
        ])
      );

      const req = httpMock.expectOne(MATCH_URL);
      expect(Object.keys(req.request.body.queries)).toEqual([
        'client-address-21-0',
        'client-address-21-1'
      ]);
      expect(req.request.body.queries['client-address-21-0']).toEqual({
        schema: 'Address',
        properties: {
          full: ['9 Ilyinka Street, Moscow, Moscow Oblast, 109097, Russia'],
          street: ['9 Ilyinka Street'],
          city: ['Moscow'],
          region: ['Moscow Oblast'],
          postalCode: ['109097'],
          country: ['Russia']
        }
      });
      expect(req.request.body.queries['client-address-21-1'].properties.full).toEqual(['Kano, Nigeria']);

      req.flush({
        responses: {
          'client-address-21-0': {
            results: [
              {
                id: 'addr-1',
                caption: '9 Ilyinka Street, Moscow, 109097',
                schema: 'Address',
                score: 0.98,
                properties: { street: ['9 Ilyinka Street'], full: ['9 Ilyinka Street, Moscow, 109097'] }
              }
            ]
          },
          'client-address-21-1': {
            results: [
              // Country-only record: matches nearly every local address, so it is dropped.
              { id: 'addr-ng', caption: 'Nigeria', schema: 'Address', score: 0.88, properties: { full: ['Nigeria'] } },
              // Same entity as the first query with a lower score: the higher score wins.
              {
                id: 'addr-1',
                caption: '9 Ilyinka Street, Moscow, 109097',
                schema: 'Address',
                score: 0.71,
                properties: { street: ['9 Ilyinka Street'] }
              }
            ]
          }
        }
      });

      const result = await resultPromise;
      expect(result.status).toBe('match');
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        id: 'addr-1',
        score: 0.98,
        matchedClientValue: '9 Ilyinka Street, Moscow, Moscow Oblast, 109097, Russia'
      });
    });

    it('rejects when no active address has any text', async () => {
      await expect(
        firstValueFrom(
          service.screenClientAddress({ id: 22 }, [
            { isActive: false, city: 'Lagos' },
            {}
          ])
        )
      ).rejects.toThrow('errors.clientScreeningMissingAddress');
    });

    it('adds the listed entities linked to the top address matches', async () => {
      const result: ClientScreeningResult = {
        type: 'address',
        status: 'match',
        matches: [
          {
            id: 'addr-1',
            caption: 'A',
            score: 0.98,
            datasets: [],
            topics: [],
            countries: [],
            birthDates: [],
            addresses: [],
            sourceUrls: [],
            features: []
          },
          {
            id: 'addr-2',
            caption: 'B',
            score: 0.9,
            datasets: [],
            topics: [],
            countries: [],
            birthDates: [],
            addresses: [],
            sourceUrls: [],
            features: []
          }
        ]
      };

      const enrichedPromise = firstValueFrom(service.enrichAddressMatches(result));

      httpMock.expectOne(`${YENTE}/entities/addr-1?nested=true`).flush({
        id: 'addr-1',
        properties: {
          things: [
            {
              id: 'NK-1',
              caption: 'National Wealth Fund',
              schema: 'Company',
              datasets: ['us_ofac_cons'],
              properties: { topics: ['sanction'] }
            },
            // Unexpanded references (plain ids) are ignored.
            'NK-2'
          ]
        }
      });
      // A failed lookup must not fail the whole result.
      httpMock.expectOne(`${YENTE}/entities/addr-2?nested=true`).flush('boom', { status: 500, statusText: 'Error' });

      const enriched = await enrichedPromise;
      expect(enriched.matches[0].linkedEntities).toEqual([
        {
          id: 'NK-1',
          caption: 'National Wealth Fund',
          schema: 'Company',
          topics: ['sanction'],
          datasets: ['us_ofac_cons']
        }
      ]);
      expect(enriched.matches[1].linkedEntities).toEqual([]);
    });

    it('skips the linked-entity lookup for name results and empty address results', async () => {
      const nameResult: ClientScreeningResult = { type: 'name', status: 'clear', matches: [] };
      expect(await firstValueFrom(service.enrichAddressMatches(nameResult))).toBe(nameResult);
      httpMock.expectNone(() => true);
    });
  });

  describe('configuration and notes', () => {
    it('is enabled when only the Yente URL is configured', () => {
      environment.enableYenteScreening = false;
      environment.yenteScreeningUrl = YENTE;
      expect(service.enabled).toBe(true);
    });

    it('is disabled when neither the flag nor the URL is set', () => {
      environment.enableYenteScreening = false;
      environment.yenteScreeningUrl = '  ';
      expect(service.enabled).toBe(false);
    });

    it('fails with a configuration error when the URL is missing', async () => {
      environment.yenteScreeningUrl = '';
      await expect(firstValueFrom(service.screenClientName({ id: 30, displayName: 'X' }))).rejects.toThrow(
        'errors.clientScreeningNotConfigured'
      );
    });

    it('builds an audit note covering the completed checks only', () => {
      const note = service.buildScreeningNote([
        {
          type: 'name',
          status: 'possible-match',
          screenedAt: '2026-11-15T10:00:00.000Z',
          screenedAttributes: [{ labelKey: 'labels.inputs.Date of Birth', values: ['1980-03-07'] }],
          matches: [
            {
              id: 'nk-1',
              caption: 'Jane Doe',
              score: 0.75,
              topics: ['role.pep'],
              datasets: [],
              countries: [],
              birthDates: [],
              addresses: [],
              sourceUrls: [],
              features: []
            }
          ]
        },
        { type: 'address', status: 'idle', matches: [] }
      ]);

      expect(note).toContain('dataset "sanctions"');
      expect(note).toContain('match >= 0.85, possible match >= 0.7');
      expect(note).toContain('Name check: POSSIBLE-MATCH');
      expect(note).toContain('- Date of Birth: 1980-03-07');
      expect(note).toContain('* Jane Doe (nk-1) score 0.75 [role.pep]');
      expect(note).not.toContain('Address check');
    });
  });
});

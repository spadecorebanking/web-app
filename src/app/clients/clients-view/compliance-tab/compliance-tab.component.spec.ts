/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { describe, beforeEach, expect, it, jest } from '@jest/globals';
import { ClientsService } from '../../clients.service';
import { ClientScreeningResult } from '../../models/client-screening.model';
import { ClientScreeningService } from '../../services/client-screening.service';
import { AuthenticationService } from 'app/core/authentication/authentication.service';
import { ComplianceTabComponent } from './compliance-tab.component';

/**
 * The tab gets the client from the parent route, so the tests drive it
 * through a BehaviorSubject standing in for `route.parent.data`. This also
 * covers navigating from one client to another while the tab is open.
 */
describe('ComplianceTabComponent', () => {
  let component: ComplianceTabComponent;
  let fixture: ComponentFixture<ComplianceTabComponent>;
  let clientsService: jest.Mocked<Pick<ClientsService, 'getClientAddressData' | 'createClientNote'>>;
  let screeningService: any;
  let parentData$: BehaviorSubject<any>;

  const addresses = [{ addressLine1: '1 Main Street', city: 'Lagos', countryName: 'Nigeria' }];

  const result = (overrides: Partial<ClientScreeningResult>): ClientScreeningResult => ({
    type: 'name',
    status: 'clear',
    matches: [],
    screenedAt: '2026-11-15T10:00:00.000Z',
    ...overrides
  });

  beforeEach(async () => {
    parentData$ = new BehaviorSubject<any>({ clientViewData: { id: 55, displayName: 'Jane Doe' } });

    clientsService = {
      getClientAddressData: jest.fn(() => of(addresses)),
      createClientNote: jest.fn(() => of({ resourceId: 1 }))
    } as any;

    screeningService = {
      enabled: true,
      dataset: 'sanctions',
      screenClientName: jest.fn(() => of(result({ type: 'name' }))),
      screenClientAddress: jest.fn(() => of(result({ type: 'address' }))),
      enrichAddressMatches: jest.fn((value: ClientScreeningResult) => of(value)),
      buildScreeningNote: jest.fn(() => 'note body')
    };

    await TestBed.configureTestingModule({
      imports: [
        ComplianceTabComponent,
        TranslateModule.forRoot()
      ],
      providers: [
        { provide: ClientsService, useValue: clientsService },
        { provide: ClientScreeningService, useValue: screeningService },
        { provide: ActivatedRoute, useValue: { parent: { data: parentData$ } } },
        // Needed by the *mifosxHasPermission directive on the "Save to notes" button.
        { provide: AuthenticationService, useValue: { getCredentials: () => ({ permissions: ['ALL_FUNCTIONS'] }) } },
        provideAnimationsAsync()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ComplianceTabComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('reads the client from the parent route and does not screen on open', () => {
    expect(component.clientViewData.id).toBe(55);
    expect(screeningService.screenClientName).not.toHaveBeenCalled();
    expect(screeningService.screenClientAddress).not.toHaveBeenCalled();
    expect(component.overallStatus).toBe('idle');
  });

  it('passes the addresses on file to the name check so the country can be used', () => {
    screeningService.screenClientName.mockReturnValue(of(result({ status: 'possible-match' })));

    component.runNameScreening();

    expect(screeningService.screenClientName).toHaveBeenCalledWith(component.clientViewData, addresses);
    expect(component.nameScreeningResult.status).toBe('possible-match');
    expect(component.isNameLoading).toBe(false);
  });

  it('still runs the name check without a country when the address lookup fails', () => {
    clientsService.getClientAddressData.mockReturnValue(throwError(() => new Error('403')));
    parentData$.next({ clientViewData: { id: 56, displayName: 'John Doe' } });

    component.runNameScreening();

    expect(screeningService.screenClientName).toHaveBeenCalledWith(component.clientViewData, []);
  });

  it('fetches the addresses only once for both checks', () => {
    component.runAllScreening();

    expect(clientsService.getClientAddressData).toHaveBeenCalledTimes(1);
    expect(screeningService.screenClientName).toHaveBeenCalledTimes(1);
    expect(screeningService.screenClientAddress).toHaveBeenCalledWith(component.clientViewData, addresses);
    expect(screeningService.enrichAddressMatches).toHaveBeenCalledTimes(1);
  });

  it('reports the most serious status as the overall status', () => {
    screeningService.screenClientName.mockReturnValue(of(result({ status: 'clear' })));
    screeningService.screenClientAddress.mockReturnValue(of(result({ type: 'address', status: 'match' })));

    component.runAllScreening();

    expect(component.overallStatus).toBe('match');
  });

  it('never reports clear overall when one check failed', () => {
    screeningService.screenClientName.mockReturnValue(of(result({ status: 'clear' })));
    screeningService.screenClientAddress.mockReturnValue(throwError(() => new Error('Http failure')));

    component.runAllScreening();

    expect(component.addressScreeningResult.status).toBe('error');
    expect(component.addressScreeningResult.errorMessageKey).toBe('errors.clientScreeningRequestFailed');
    expect(component.overallStatus).toBe('error');
  });

  it('marks the address check unavailable when the client has no usable address', () => {
    screeningService.screenClientAddress.mockReturnValue(
      throwError(() => new Error('errors.clientScreeningMissingAddress'))
    );

    component.runAddressScreening();

    expect(component.addressScreeningResult.status).toBe('unavailable');
    expect(component.addressScreeningResult.errorMessageKey).toBe('errors.clientScreeningMissingAddress');
  });

  it('shows an address lookup error instead of screening when addresses cannot be loaded', () => {
    clientsService.getClientAddressData.mockReturnValue(throwError(() => new Error('403')));
    parentData$.next({ clientViewData: { id: 57, displayName: 'No Access' } });

    component.runAddressScreening();

    expect(screeningService.screenClientAddress).not.toHaveBeenCalled();
    expect(component.addressScreeningResult.errorMessageKey).toBe('errors.clientScreeningAddressLookupFailed');
  });

  it('saves the screening summary to the client notes once per set of results', () => {
    expect(component.canSaveNote).toBe(false);

    component.runNameScreening();
    expect(component.canSaveNote).toBe(true);

    component.saveToNotes();

    expect(screeningService.buildScreeningNote).toHaveBeenCalledWith([
      component.nameScreeningResult,
      component.addressScreeningResult
    ]);
    expect(clientsService.createClientNote).toHaveBeenCalledWith('55', { note: 'note body' });
    expect(component.noteSaved).toBe(true);
    expect(component.canSaveNote).toBe(false);

    // A new check produces new results, which can be saved again.
    component.runNameScreening();
    expect(component.canSaveNote).toBe(true);
  });

  it('shows an error when the note cannot be saved', () => {
    clientsService.createClientNote.mockReturnValue(throwError(() => new Error('500')));
    component.runNameScreening();

    component.saveToNotes();

    expect(component.noteSaved).toBe(false);
    expect(component.noteMessageIsError).toBe(true);
    expect(component.noteMessageKey).toBe('labels.messages.Screening summary could not be saved');
  });

  it('clears results when the operator navigates to another client', () => {
    screeningService.screenClientName.mockReturnValue(of(result({ status: 'match' })));
    component.runNameScreening();
    expect(component.nameScreeningResult.status).toBe('match');

    parentData$.next({ clientViewData: { id: 99, displayName: 'Someone Else' } });

    expect(component.clientViewData.id).toBe(99);
    expect(component.nameScreeningResult.status).toBe('idle');
    expect(clientsService.getClientAddressData).toHaveBeenLastCalledWith('99');
  });

  it('keeps results when the parent data re-emits for the same client', () => {
    screeningService.screenClientName.mockReturnValue(of(result({ status: 'match' })));
    component.runNameScreening();

    parentData$.next({ clientViewData: { id: 55, displayName: 'Jane Doe (edited)' } });

    expect(component.nameScreeningResult.status).toBe('match');
  });

  it('maps known topics to labels and leaves unknown ones as raw codes', () => {
    expect(component.topicLabelKey('role.pep')).toBe('labels.inputs.Politically Exposed Person');
    expect(component.topicLabelKey('gov.soe')).toBeNull();
    expect(component.isHighRiskTopic('sanction')).toBe(true);
    expect(component.isHighRiskTopic('role.pep')).toBe(false);
  });

  it('renders the not-configured message when screening is disabled', () => {
    screeningService.enabled = false;
    const disabledFixture = TestBed.createComponent(ComplianceTabComponent);
    disabledFixture.detectChanges();

    expect(disabledFixture.nativeElement.textContent).toContain('labels.messages.Client screening is not configured');
    expect(disabledFixture.nativeElement.querySelector('button')).toBeNull();
  });
});

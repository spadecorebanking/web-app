/**
 * Copyright since 2026 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of, throwError } from 'rxjs';
import { ClientsService } from 'app/clients/clients.service';
import { Dates } from 'app/core/utils/dates';
import { SettingsService } from 'app/settings/settings.service';
import { AccountTransfersService } from '../account-transfers.service';
import { InterbankBank } from '../interbank-banks';
import { MakeAccountTransfersComponent } from './make-account-transfers.component';

describe('MakeAccountTransfersComponent (interbank)', () => {
  let accountTransfersService: { getInterbankBanks: jest.Mock; sendInterbankTransfer: jest.Mock };
  let markForCheck: jest.Mock;

  const banks: InterbankBank[] = [
    { id: '058', name: 'GT Bank' },
    { id: '050', name: 'Eco Bank' },
    { id: '044', name: 'Access Bank' }
  ];

  /** What GET /accounttransfers/template returns for a savings account, trimmed to the fields the form reads. */
  const transferTemplate: any = {
    fromClient: { id: 2, displayName: 'Client Two', officeId: 1 },
    fromAccount: { id: 5, availableBalance: 1000, externalId: ' 0700000000 ' },
    currency: { code: 'NGN', name: 'Nigerian Naira' },
    toOfficeOptions: [],
    toAccountTypeOptions: [],
    toAccountOptions: []
  };

  /**
   * Builds the component for an interbank transfer and runs ngOnInit, without rendering the template.
   * @param bankList What `getInterbankBanks()` emits; defaults to the three test banks.
   * @returns The initialised component.
   */
  function createComponent(bankList: Observable<InterbankBank[]> = of(banks)): MakeAccountTransfersComponent {
    accountTransfersService = {
      getInterbankBanks: jest.fn(() => bankList),
      sendInterbankTransfer: jest.fn(() => of({ transactionId: 'tx-1' }))
    };
    markForCheck = jest.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        FormBuilder,
        {
          provide: ActivatedRoute,
          useValue: {
            data: of({ accountTransferTemplate: transferTemplate }),
            snapshot: { queryParams: { accountType: 'interbank', savingsId: '5', interbank: 'true' } }
          }
        },
        { provide: Router, useValue: { currentNavigation: (): null => null } },
        { provide: AccountTransfersService, useValue: accountTransfersService },
        {
          provide: SettingsService,
          useValue: { businessDate: new Date(2026, 10, 16), dateFormat: 'dd MMMM yyyy', language: { code: 'en' } }
        },
        { provide: Dates, useValue: { formatDate: jest.fn() } },
        { provide: ClientsService, useValue: {} },
        { provide: TranslateService, useValue: { instant: (key: string) => key } },
        { provide: ChangeDetectorRef, useValue: { markForCheck } }
      ]
    });
    const component = TestBed.runInInjectionContext(() => new MakeAccountTransfersComponent());
    component.ngOnInit();
    return component;
  }

  it('should load the bank list for the Bank dropdown', () => {
    const component = createComponent();

    expect(accountTransfersService.getInterbankBanks).toHaveBeenCalledTimes(1);
    expect(component.interbankBanks).toEqual(banks);
    expect(component.interbankBanksLoading).toBe(false);
    expect(component.interbankBanksLoadFailed).toBe(false);
    expect(markForCheck).toHaveBeenCalled();
  });

  it('should require a bank and a 10 digit account number', () => {
    const component = createComponent();
    const form = component.beneficiaryForm;
    const accountNumber = form.get('toAccountNumber');

    expect(form.valid).toBe(false);

    form.patchValue({ toBank: '058', toAccountNumber: '12345' });
    expect(accountNumber.hasError('pattern')).toBe(true);

    accountNumber.setValue('012345678a');
    expect(accountNumber.hasError('pattern')).toBe(true);

    accountNumber.setValue('01234567890');
    expect(accountNumber.hasError('pattern')).toBe(true);

    accountNumber.setValue('0123456789');
    expect(form.valid).toBe(true);

    form.patchValue({ toBank: '' });
    expect(form.valid).toBe(false);
  });

  it('should show the bank name for the selected bank id', () => {
    const component = createComponent();

    expect(component.getSelectedBankName()).toBe('');

    component.beneficiaryForm.patchValue({ toBank: '050' });
    expect(component.getSelectedBankName()).toBe('Eco Bank');

    component.beneficiaryForm.patchValue({ toBank: '999' });
    expect(component.getSelectedBankName()).toBe('999');
  });

  it('should report a failed bank list and load it again on retry', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const component = createComponent(throwError(() => new Error('offline')));

    expect(component.interbankBanksLoadFailed).toBe(true);
    expect(component.interbankBanksLoading).toBe(false);
    expect(component.interbankBanks).toEqual([]);

    accountTransfersService.getInterbankBanks.mockReturnValue(of(banks));
    component.loadInterbankBanks();

    expect(component.interbankBanksLoadFailed).toBe(false);
    expect(component.interbankBanks).toEqual(banks);
    consoleError.mockRestore();
  });

  it('should send the selected bank and account number as the receiving party', () => {
    // jsdom has no crypto.randomUUID, which the component uses for homeTransactionId.
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'uuid-1', configurable: true });
    const component = createComponent();
    component.transferStepper = { next: jest.fn() } as any;
    component.beneficiaryForm.patchValue({ toBank: '044', toAccountNumber: '0123456789' });
    component.transferDetailsForm.patchValue({ transferAmount: 250, transferDescription: 'Rent' });

    component.submit();

    const payload = JSON.parse(accountTransfersService.sendInterbankTransfer.mock.calls[0][0]);
    expect(payload.to).toEqual({ fspId: '044', idType: 'ACCOUNT_ID', idValue: '0123456789' });
    expect(payload.from).toEqual(expect.objectContaining({ idType: 'MSISDN', idValue: '0700000000' }));
    expect(payload.amount).toEqual({ currencyCode: 'NGN', amount: 250 });
    expect(payload.note).toBe('Rent');
    expect(payload.homeTransactionId).toBe('uuid-1');
    expect(component.transferSuccess).toBe(true);
    expect(component.transferReferenceId).toBe('tx-1');
    delete (globalThis.crypto as any).randomUUID;
  });
});

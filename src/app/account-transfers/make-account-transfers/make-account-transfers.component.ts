/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/** Angular Imports */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  AfterViewInit,
  ViewChild,
  inject,
  DestroyRef
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { AbstractControl, FormBuilder, FormGroup, ValidationErrors, Validators, FormsModule } from '@angular/forms';

/** Custom Services */
import { AccountTransfersService } from '../account-transfers.service';
import { SettingsService } from 'app/settings/settings.service';
import { ClientsService } from 'app/clients/clients.service';
import { Dates } from 'app/core/utils/dates';
import { TranslateService } from '@ngx-translate/core';
import { InterbankBank, INTERBANK_ACCOUNT_NUMBER_LENGTH } from '../interbank-banks';

/** Environment Configuration */
import { environment } from '../../../environments/environment';
import { MatDivider } from '@angular/material/divider';
import { MatHint } from '@angular/material/form-field';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatAutocompleteTrigger, MatAutocomplete } from '@angular/material/autocomplete';
import {
  MatStepper,
  MatStepperIcon,
  MatStep,
  MatStepLabel,
  MatStepperNext,
  MatStepperPrevious
} from '@angular/material/stepper';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { STANDALONE_SHARED_IMPORTS } from 'app/standalone-shared.module';

/**
 * Create account transfers
 */
@Component({
  selector: 'mifosx-make-account-transfers',
  templateUrl: './make-account-transfers.component.html',
  styleUrls: ['./make-account-transfers.component.scss'],
  imports: [
    ...STANDALONE_SHARED_IMPORTS,
    MatDivider,
    FormsModule,
    MatHint,
    MatAutocompleteTrigger,
    MatAutocomplete,
    MatStepper,
    MatStepperIcon,
    MatStep,
    MatStepLabel,
    MatStepperNext,
    MatStepperPrevious,
    FaIconComponent,
    CdkTextareaAutosize,
    MatProgressSpinner
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MakeAccountTransfersComponent implements OnInit, AfterViewInit {
  private formBuilder = inject(FormBuilder);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private accountTransfersService = inject(AccountTransfersService);
  private dateUtils = inject(Dates);
  private settingsService = inject(SettingsService);
  private clientsService = inject(ClientsService);
  private translateService = inject(TranslateService);
  private destroyRef = inject(DestroyRef);
  private cdr = inject(ChangeDetectorRef);

  /** Stepper reference */
  @ViewChild('transferStepper') transferStepper: MatStepper;

  /** Standing Instructions Data */
  accountTransferTemplateData: any;
  /** Minimum date allowed. */
  minDate = new Date(2000, 0, 1);
  /** Maximum date allowed. */
  maxDate = new Date(2100, 0, 1);
  /** Beneficiary selection form (Step 1) */
  beneficiaryForm: FormGroup;
  /** Transfer details form (Step 2) */
  transferDetailsForm: FormGroup;
  /** To Office Type Data */
  toOfficeTypeData: any;
  /** To Client Type Data */
  toClientTypeData: any;
  /** To Account Type Data */
  toAccountTypeData: any;
  /** To Account Data */
  toAccountData: any;
  /** Account Type Id */
  accountTypeId: any;
  /** Account Type */
  accountType: any;
  /** Savings Id or Loans Id */
  id: any;
  /** Clients Data */
  clientsData: any;
  /** interbank transfer */
  interbank: boolean = false;
  /** Banks offered in the interbank "Bank" dropdown. Empty until `loadInterbankBanks()` returns. */
  interbankBanks: InterbankBank[] = [];
  /** True while the bank list is being fetched; the Bank field shows a loading hint meanwhile. */
  interbankBanksLoading: boolean = false;
  /** True when the bank list request failed; the form shows an error with a Retry button. */
  interbankBanksLoadFailed: boolean = false;
  /** Required length of the receiving account number, used by the validator, `maxlength` and the hint. */
  readonly accountNumberLength = INTERBANK_ACCOUNT_NUMBER_LENGTH;
  balance: number = 0;
  isLoading: boolean = false;
  /** Transfer status flags (Step 3) */
  transferComplete: boolean = false;
  transferSuccess: boolean = false;
  transferErrorMessage: string = '';
  transferReferenceId: string = '';

  /**
   * Retrieves the standing instructions template from `resolve`.
   */
  constructor() {
    this.route.data.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((data: { accountTransferTemplate: any }) => {
      this.accountTransferTemplateData = data.accountTransferTemplate;
      this.setParams();
      this.setOptions();
    });
  }

  /** Sets the value from the URL */
  setParams() {
    this.accountType = this.route.snapshot.queryParams['accountType'];
    switch (this.accountType) {
      case 'fromloans':
        this.accountTypeId = '1';
        this.id = this.route.snapshot.queryParams['loanId'];
        break;
      case 'fromsavings':
      case 'interbank':
        this.accountTypeId = '2';
        this.id = this.route.snapshot.queryParams['savingsId'];
        this.interbank = this.route.snapshot.queryParams['interbank'] === 'true';
        const navigationBalance = this.router.currentNavigation()?.extras?.state?.balance;
        const templateBalance =
          this.accountTransferTemplateData?.fromAccount?.availableBalance ??
          this.accountTransferTemplateData?.fromAccount?.summary?.accountBalance ??
          this.accountTransferTemplateData?.fromAccount?.balance ??
          0;
        this.balance = typeof navigationBalance === 'number' ? navigationBalance : templateBalance;
        break;
      default:
        this.accountTypeId = '0';
    }
  }

  /**
   * Creates and sets the beneficiary and transfer details forms.
   */
  ngOnInit() {
    this.maxDate = this.settingsService.businessDate;
    if (!this.interbank) {
      this.createNormalBeneficiaryForm();
    } else {
      this.createInterbankBeneficiaryForm();
      this.loadInterbankBanks();
    }
    this.createTransferDetailsForm();
  }

  /**
   * Creates the beneficiary form for normal (non-interbank) transfers.
   */
  createNormalBeneficiaryForm() {
    this.beneficiaryForm = this.formBuilder.group({
      toOfficeId: [
        '',
        Validators.required
      ],
      toClientId: [
        '',
        Validators.required
      ],
      toAccountType: [
        '',
        Validators.required
      ],
      toAccountId: [
        '',
        Validators.required
      ]
    });
  }

  /**
   * Creates the beneficiary form for interbank transfers (Step 1): the
   * receiving bank and the account number at that bank.
   *
   * - `toBank` holds the selected bank's `id` (see `InterbankBank`), which is
   *   sent as `to.fspId` when the transfer is submitted.
   * - `toAccountNumber` must be exactly `accountNumberLength` digits (a
   *   10-digit NUBAN by default). The pattern rejects spaces and letters, so
   *   the value can be sent to the switch unchanged.
   *
   * Step 1 can be left as soon as both fields are valid. There is no name
   * enquiry yet, so staff should confirm the account holder with the customer
   * before submitting.
   */
  createInterbankBeneficiaryForm() {
    this.beneficiaryForm = this.formBuilder.group({
      toBank: [
        '',
        Validators.required
      ],
      toAccountNumber: [
        '',
        [
          Validators.required,
          Validators.pattern(new RegExp(`^\\d{${this.accountNumberLength}}$`))
        ]
      ]
    });
  }

  /**
   * Loads the banks for the interbank "Bank" dropdown from
   * `AccountTransfersService.getInterbankBanks()`.
   *
   * The service returns a placeholder list for now. The loading and failure
   * flags are already handled here so that connecting the real API needs no
   * changes in this component. This component uses OnPush change detection,
   * so each result calls `markForCheck()` to update the view. A failed load
   * can be retried from the Retry button in the template.
   */
  loadInterbankBanks() {
    this.interbankBanksLoading = true;
    this.interbankBanksLoadFailed = false;
    this.accountTransfersService
      .getInterbankBanks()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (banks) => {
          this.interbankBanks = banks ?? [];
          this.interbankBanksLoading = false;
          this.cdr.markForCheck();
        },
        error: (error) => {
          console.error('Loading interbank banks failed:', error);
          this.interbankBanks = [];
          this.interbankBanksLoading = false;
          this.interbankBanksLoadFailed = true;
          this.cdr.markForCheck();
        }
      });
  }

  /**
   * Returns the name of the bank selected in the interbank form, for the
   * Step 2 and Step 3 summaries. The form stores only the bank id, so the
   * name is looked up in the loaded list. If the id is not in the list, the
   * id itself is returned so the summary is never blank.
   */
  getSelectedBankName(): string {
    const bankId = this.beneficiaryForm?.get('toBank')?.value;
    if (!bankId) {
      return '';
    }
    return this.interbankBanks.find((bank) => bank.id === bankId)?.name ?? bankId;
  }

  /**
   * Creates the transfer details form (Step 2).
   */
  createTransferDetailsForm() {
    const defaultAmount =
      this.accountTransferTemplateData?.transferAmount > 0 ? this.accountTransferTemplateData.transferAmount : '';

    this.transferDetailsForm = this.formBuilder.group({
      transferDate: [
        this.settingsService.businessDate,
        Validators.required
      ],
      transferAmount: [
        defaultAmount,
        [
          Validators.required,
          Validators.min(0.01),
          this.amountExceedsBalanceValidator.bind(this)
        ]
      ],
      transferDescription: [
        '',
        Validators.required
      ]
    });
  }

  amountExceedsBalanceValidator(control: AbstractControl): ValidationErrors | null {
    const amount = control.value;
    return amount > this.balance ? { amountExceedsBalance: true } : null;
  }

  /** Sets options value */
  setOptions() {
    this.toOfficeTypeData = this.accountTransferTemplateData.toOfficeOptions;
    this.toAccountTypeData = this.accountTransferTemplateData.toAccountTypeOptions;
    this.toAccountData = this.accountTransferTemplateData.toAccountOptions;
  }

  /** Executes on change of various select options */
  changeEvent() {
    const formValue = this.refineObject({ ...this.beneficiaryForm.value });
    this.accountTransfersService
      .newAccountTranferResource(this.id, this.accountTypeId, formValue)
      .subscribe((response: any) => {
        this.accountTransferTemplateData = response;
        this.toClientTypeData = response.toClientOptions;
        this.setOptions();
      });
  }

  /** Refine Object
   * Removes the object param with null or '' values
   */
  refineObject(dataObj: any) {
    if (dataObj.toClientId && typeof dataObj.toClientId === 'object') {
      dataObj.toClientId = dataObj.toClientId.id;
    }
    const propNames = Object.getOwnPropertyNames(dataObj);
    for (let i = 0; i < propNames.length; i++) {
      const propName = propNames[i];
      if (dataObj[propName] === null || dataObj[propName] === undefined || dataObj[propName] === '') {
        delete dataObj[propName];
      }
    }
    return dataObj;
  }

  /**
   * Subscribes to Clients search filter:
   */
  ngAfterViewInit() {
    if (!this.interbank && this.beneficiaryForm) {
      this.beneficiaryForm.controls.toClientId.valueChanges
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((value: any) => {
          if (typeof value === 'string' && value.length >= 2) {
            const searchedValue = value;
            this.clientsService.getFilteredClients('displayName', 'ASC', true, value).subscribe((data: any) => {
              if (this.beneficiaryForm.controls.toClientId.value !== searchedValue) {
                return;
              }
              this.clientsData = data.pageItems;
              this.cdr.markForCheck();
            });
          } else if (typeof value === 'number') {
            this.changeEvent();
          }
        });
    }
  }

  /**
   * Displays Client name in form control input.
   * @param {any} client Client data.
   * @returns {string} Client name if valid otherwise undefined.
   */
  displayClient(client: any): string | undefined {
    return client ? client.displayName : undefined;
  }

  /** Helper methods for displaying selected beneficiary info in Step 2 summary */
  getSelectedOfficeName(): string {
    const officeId = this.beneficiaryForm?.get('toOfficeId')?.value;
    const office = this.toOfficeTypeData?.find((o: any) => o.id === officeId);
    return office ? office.name : '';
  }

  getSelectedClientName(): string {
    const client = this.beneficiaryForm?.get('toClientId')?.value;
    if (typeof client === 'object' && client) {
      return client.displayName;
    }
    return client || '';
  }

  getSelectedAccountTypeName(): string {
    const typeId = this.beneficiaryForm?.get('toAccountType')?.value;
    const type = this.toAccountTypeData?.find((t: any) => t.id === typeId);
    return type ? type.value : '';
  }

  getSelectedAccountName(): string {
    const accountId = this.beneficiaryForm?.get('toAccountId')?.value;
    const account = this.toAccountData?.find((a: any) => a.id === accountId);
    return account ? `${account.productName} - ${account.accountNo}` : '';
  }

  /**
   * Submits the transfer
   */
  submit() {
    this.interbank ? this.makeInterbankTransfer() : this.makeTransfer();
  }

  makeTransfer() {
    this.isLoading = true;
    const dateFormat = this.settingsService.dateFormat;
    const locale = this.settingsService.language.code;

    let toClientIdValue: any;
    if (typeof this.beneficiaryForm.controls.toClientId.value === 'object') {
      toClientIdValue = this.beneficiaryForm.controls.toClientId.value.id;
    } else {
      toClientIdValue = this.beneficiaryForm.controls.toClientId.value;
    }

    const makeAccountTransferData = {
      ...this.beneficiaryForm.value,
      ...this.transferDetailsForm.value,
      transferDate: this.dateUtils.formatDate(this.transferDetailsForm.value.transferDate, dateFormat),
      dateFormat,
      locale,
      toClientId: toClientIdValue,
      fromAccountId: this.id,
      fromAccountType: this.accountTypeId,
      fromClientId: this.accountTransferTemplateData.fromClient.id,
      fromOfficeId: this.accountTransferTemplateData.fromClient.officeId
    };

    this.accountTransfersService.createAccountTransfer(makeAccountTransferData).subscribe(
      (response: any) => {
        this.transferComplete = true;
        this.transferSuccess = true;
        this.transferReferenceId = response?.resourceId || response?.transactionId || '';
        this.transferStepper.next();
        this.isLoading = false;
      },
      (error: any) => {
        this.transferComplete = true;
        this.transferSuccess = false;
        this.transferErrorMessage =
          error?.error?.defaultUserMessage ||
          error?.message ||
          this.translateService.instant('errors.generic.unexpectedShort');
        this.transferStepper.next();
        this.isLoading = false;
      }
    );
  }

  makeInterbankTransfer() {
    this.isLoading = true;

    const payload = {
      homeTransactionId: crypto.randomUUID(),
      from: {
        fspId: environment.fineractPlatformTenantId,
        idType: 'MSISDN',
        idValue: this.accountTransferTemplateData.fromAccount.externalId?.trim() || ''
      },
      // The receiving party is identified by its account number at the selected bank, so the
      // id type is the Mojaloop party type for account numbers (the payer is still identified
      // by MSISDN). The bank list API and the transfer API must agree on the bank id sent as fspId.
      to: {
        fspId: this.beneficiaryForm.controls.toBank.value,
        idType: 'ACCOUNT_ID',
        idValue: this.beneficiaryForm.controls.toAccountNumber.value
      },
      amountType: 'SEND',
      amount: {
        currencyCode: this.accountTransferTemplateData.currency.code,
        amount: this.transferDetailsForm.controls.transferAmount.value
      },
      transactionType: {
        scenario: 'TRANSFER',
        subScenario: 'DOMESTIC',
        initiator: 'PAYER',
        initiatorType: 'CUSTOMER'
      },
      note: this.transferDetailsForm.controls.transferDescription.value
    };

    this.accountTransfersService.sendInterbankTransfer(JSON.stringify(payload)).subscribe(
      (trnsfr) => {
        this.transferComplete = true;
        this.transferSuccess = true;
        this.transferReferenceId = trnsfr?.transactionId || trnsfr?.homeTransactionId || '';
        this.transferStepper.next();
        this.isLoading = false;
      },
      (error) => {
        console.error('Interbank transfer error:', error);
        this.transferComplete = true;
        this.transferSuccess = false;
        this.transferErrorMessage =
          error?.error?.defaultUserMessage ||
          error?.message ||
          this.translateService.instant('errors.generic.unexpectedRetry');
        this.transferStepper.next();
        this.isLoading = false;
      }
    );
  }
}

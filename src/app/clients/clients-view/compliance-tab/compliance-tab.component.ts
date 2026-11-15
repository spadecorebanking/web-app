/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { MatButton } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import {
  MatExpansionPanel,
  MatExpansionPanelDescription,
  MatExpansionPanelHeader,
  MatExpansionPanelTitle
} from '@angular/material/expansion';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Observable, Subscription, of, throwError } from 'rxjs';
import { catchError, finalize, shareReplay, switchMap } from 'rxjs/operators';
import { STANDALONE_SHARED_IMPORTS } from 'app/standalone-shared.module';
import { ClientsService } from '../../clients.service';
import {
  ClientAddressRecord,
  ClientScreeningResult,
  ClientScreeningStatus,
  ClientScreeningType,
  ScreenableClient
} from '../../models/client-screening.model';
import { ClientScreeningService } from '../../services/client-screening.service';

/**
 * Translation keys for the FollowTheMoney topics an operator is most likely
 * to see on a sanctions or PEP hit. Topics that are not listed here are
 * shown as their raw code (for example `gov.soe`), so a newer topic from
 * OpenSanctions is still visible.
 */
const TOPIC_LABEL_KEYS: Record<string, string> = {
  sanction: 'labels.inputs.Sanctioned',
  'sanction.linked': 'labels.inputs.Sanction-linked',
  'sanction.counter': 'labels.inputs.Sanctioned',
  'role.pep': 'labels.inputs.Politically Exposed Person',
  'role.rca': 'labels.inputs.Close Associate of PEP',
  'role.pol': 'labels.inputs.Politician',
  'role.oligarch': 'labels.inputs.Oligarch',
  crime: 'labels.inputs.Crime',
  'crime.terror': 'labels.inputs.Terrorism',
  'crime.fin': 'labels.inputs.Financial Crime',
  'crime.fraud': 'labels.inputs.Fraud',
  wanted: 'labels.inputs.Wanted',
  debarment: 'labels.inputs.Debarred',
  poi: 'labels.inputs.Person of Interest',
  'export.control': 'labels.inputs.Export Controlled',
  'reg.action': 'labels.inputs.Regulatory Action'
};

/**
 * Topics shown in the danger colour. They indicate a legal prohibition or
 * serious crime, not only heightened risk.
 */
const HIGH_RISK_TOPICS = new Set([
  'sanction',
  'sanction.linked',
  'sanction.counter',
  'crime.terror',
  'wanted'
]);

/**
 * Order used to combine the two checks into one overall status: the more
 * serious status wins. `error` ranks above `clear` because a failed check
 * must not let the summary say the client is clear.
 */
const STATUS_SEVERITY: Record<ClientScreeningStatus, number> = {
  idle: 0,
  unavailable: 1,
  clear: 2,
  loading: 3,
  error: 4,
  'possible-match': 5,
  match: 6
};

/**
 * Client "Compliance" tab: sanctions and PEP screening against a Yente
 * (OpenSanctions) server.
 *
 * Replaces the screening card that used to sit above the client tabs. That
 * card took space on every client page, which is unnecessary for a check
 * that runs only when someone asks for it.
 *
 * Behaviour:
 * - The client record comes from the parent `:clientId` route (it is already
 *   resolved there). The addresses are fetched once, in the background, and
 *   shared by both checks: the name check uses the country as a qualifier,
 *   and the address check screens each address.
 * - Checks run only when the operator clicks a button. Nothing is sent to
 *   Yente when the tab opens.
 * - Results stay in memory. The operator can save a plain-text summary to the
 *   client's Notes as an audit record (needs `CREATE_CLIENTNOTE`).
 */
@Component({
  selector: 'mifosx-client-compliance-tab',
  templateUrl: './compliance-tab.component.html',
  styleUrls: ['./compliance-tab.component.scss'],
  imports: [
    ...STANDALONE_SHARED_IMPORTS,
    MatButton,
    MatIcon,
    MatProgressSpinner,
    MatChipsModule,
    MatExpansionPanel,
    MatExpansionPanelHeader,
    MatExpansionPanelTitle,
    MatExpansionPanelDescription
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ComplianceTabComponent {
  private route = inject(ActivatedRoute);
  private clientsService = inject(ClientsService);
  private cdr = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);
  readonly screeningService = inject(ClientScreeningService);

  /** Client loaded by the parent `ClientViewResolver`. */
  clientViewData: ScreenableClient;

  nameScreeningResult: ClientScreeningResult = this.idleResult('name');
  addressScreeningResult: ClientScreeningResult = this.idleResult('address');

  isNameLoading = false;
  isAddressLoading = false;

  /** True while a note save request is in flight. */
  isSavingNote = false;
  /**
   * Translation key of the latest save outcome (success or failure).
   * It is cleared when a new check runs, so it always describes the results
   * currently on screen.
   */
  noteMessageKey: string | null = null;
  noteMessageIsError = false;
  /**
   * True after the current results have been saved. It stops the operator
   * from saving the same results twice. A new check resets it.
   */
  noteSaved = false;

  /**
   * Addresses on file, fetched at most once per client. Emits `null` when the
   * lookup fails (for example no `READ_ADDRESS` permission, or addresses
   * turned off for the tenant), so each check can handle that its own way
   * instead of failing.
   */
  private addresses$: Observable<ClientAddressRecord[] | null> = of(null);

  /** In-flight check subscriptions, cancelled when the client changes. */
  private nameSubscription?: Subscription;
  private addressSubscription?: Subscription;

  constructor() {
    // Angular reuses this component when the operator moves from one
    // client's Compliance tab to another's, so the parent data is watched
    // instead of read once. A new client id discards every result shown.
    this.route.parent?.data.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((data: any) => {
      const client: ScreenableClient = data?.clientViewData;
      if (!client) {
        return;
      }
      const clientChanged = String(client.id) !== String(this.clientViewData?.id);
      this.clientViewData = client;
      if (clientChanged) {
        this.resetScreeningState();
        this.addresses$ = this.createAddressStream(client.id);
      }
      this.cdr.markForCheck();
    });
  }

  /** Whether Yente screening is configured in this deployment. */
  get isEnabled(): boolean {
    return this.screeningService.enabled;
  }

  /** True when either check is in flight. */
  get isAnyLoading(): boolean {
    return this.isNameLoading || this.isAddressLoading;
  }

  /** The more serious of the two check statuses (see `STATUS_SEVERITY`). */
  get overallStatus(): ClientScreeningStatus {
    const name = this.nameScreeningResult.status;
    const address = this.addressScreeningResult.status;
    return STATUS_SEVERITY[name] >= STATUS_SEVERITY[address] ? name : address;
  }

  /**
   * True when there is at least one completed check that has not been saved
   * yet. Errors alone are not worth a note, because they carry no screening
   * outcome.
   */
  get canSaveNote(): boolean {
    const finished: ClientScreeningStatus[] = [
      'clear',
      'possible-match',
      'match',
      'unavailable'
    ];
    return (
      !this.noteSaved &&
      !this.isSavingNote &&
      !this.isAnyLoading &&
      (finished.includes(this.nameScreeningResult.status) || finished.includes(this.addressScreeningResult.status))
    );
  }

  /** Runs both checks in parallel. */
  runAllScreening(): void {
    this.runNameScreening();
    this.runAddressScreening();
  }

  /**
   * Screens the client name. Waits for the address lookup so the country
   * of residence can be sent as a qualifier. If the lookup failed, the
   * check runs without a country.
   */
  runNameScreening(): void {
    if (!this.clientViewData?.id || this.isNameLoading) {
      return;
    }

    this.startCheck('name');
    this.nameSubscription = this.addresses$
      .pipe(
        switchMap((addresses) => this.screeningService.screenClientName(this.clientViewData, addresses ?? [])),
        catchError((error) => of(this.buildErrorResult('name', error))),
        finalize(() => {
          this.isNameLoading = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.nameScreeningResult = result;
        this.cdr.markForCheck();
      });
  }

  /**
   * Screens every active address on file, then fetches the listed entities
   * linked to the top candidates (see `ClientScreeningService.enrichAddressMatches`).
   */
  runAddressScreening(): void {
    if (!this.clientViewData?.id || this.isAddressLoading) {
      return;
    }

    this.startCheck('address');
    this.addressSubscription = this.addresses$
      .pipe(
        switchMap((addresses) =>
          addresses === null
            ? throwError(() => new Error('errors.clientScreeningAddressLookupFailed'))
            : this.screeningService.screenClientAddress(this.clientViewData, addresses)
        ),
        switchMap((result) => this.screeningService.enrichAddressMatches(result)),
        catchError((error) =>
          of(
            error?.message === 'errors.clientScreeningMissingAddress'
              ? this.buildUnavailableAddressResult()
              : this.buildErrorResult('address', error)
          )
        ),
        finalize(() => {
          this.isAddressLoading = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.addressScreeningResult = result;
        this.cdr.markForCheck();
      });
  }

  /**
   * Saves a plain-text summary of the current results to the client's
   * Notes, as an audit record of who screened what and when (Fineract stores
   * the author and timestamp on each note).
   */
  saveToNotes(): void {
    if (!this.canSaveNote) {
      return;
    }

    this.isSavingNote = true;
    this.noteMessageKey = null;
    const note = this.screeningService.buildScreeningNote([
      this.nameScreeningResult,
      this.addressScreeningResult
    ]);

    this.clientsService
      .createClientNote(String(this.clientViewData.id), { note })
      .pipe(
        finalize(() => {
          this.isSavingNote = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: () => {
          this.noteSaved = true;
          this.noteMessageIsError = false;
          this.noteMessageKey = 'labels.messages.Screening summary saved to client notes';
        },
        error: () => {
          this.noteMessageIsError = true;
          this.noteMessageKey = 'labels.messages.Screening summary could not be saved';
        }
      });
  }

  /** Translation key for a status chip. */
  statusLabelKey(status: ClientScreeningStatus): string {
    const labelMap: Record<ClientScreeningStatus, string> = {
      idle: 'labels.inputs.Not Screened',
      loading: 'labels.inputs.Screening In Progress',
      clear: 'labels.inputs.Clear',
      'possible-match': 'labels.inputs.Possible Match',
      match: 'labels.inputs.Match',
      error: 'labels.inputs.Screening Error',
      unavailable: 'labels.inputs.Unavailable'
    };
    return labelMap[status];
  }

  /** Translation key for a FtM topic, or `null` to show the raw topic code. */
  topicLabelKey(topic: string): string | null {
    return TOPIC_LABEL_KEYS[topic] ?? null;
  }

  /** Whether a topic is shown in the danger colour. */
  isHighRiskTopic(topic: string): boolean {
    return HIGH_RISK_TOPICS.has(topic);
  }

  /** Turns a Yente feature id such as `person_name_jaro_winkler` into readable text. */
  featureLabel(feature: string): string {
    return feature.replace(/_/g, ' ');
  }

  /**
   * Shows the "nothing found" message only after a successful run with no
   * candidates above the threshold, or after an address check that had no
   * address to screen.
   */
  shouldShowInfoMessage(result: ClientScreeningResult): boolean {
    return (
      !!result.screenedAt &&
      !result.errorMessageKey &&
      (result.status === 'clear' || result.status === 'unavailable') &&
      result.matches.length === 0
    );
  }

  /** Marks one check as loading and clears any save message from earlier results. */
  private startCheck(type: ClientScreeningType): void {
    if (type === 'name') {
      this.isNameLoading = true;
      this.nameScreeningResult = { ...this.idleResult('name'), status: 'loading' };
    } else {
      this.isAddressLoading = true;
      this.addressScreeningResult = { ...this.idleResult('address'), status: 'loading' };
    }
    this.noteSaved = false;
    this.noteMessageKey = null;
    this.cdr.markForCheck();
  }

  /**
   * Fetches the addresses at most once, replays them to both checks, and
   * turns a failed lookup into `null`.
   */
  private createAddressStream(clientId: number | string): Observable<ClientAddressRecord[] | null> {
    return this.clientsService.getClientAddressData(String(clientId)).pipe(
      catchError(() => of(null)),
      shareReplay({ bufferSize: 1, refCount: false })
    ) as Observable<ClientAddressRecord[] | null>;
  }

  private idleResult(type: ClientScreeningType): ClientScreeningResult {
    return { type, status: 'idle', matches: [] };
  }

  /**
   * Builds an error result. A service error message that is a translation key
   * (`errors.*`) is shown as is. Anything else, such as an HttpErrorResponse
   * or a CORS failure, gets the generic "request failed" message.
   */
  private buildErrorResult(type: ClientScreeningType, error: any): ClientScreeningResult {
    const message: string | undefined = error?.message;
    return {
      type,
      status: 'error',
      matches: [],
      errorMessageKey: message?.startsWith('errors.') ? message : 'errors.clientScreeningRequestFailed'
    };
  }

  private buildUnavailableAddressResult(): ClientScreeningResult {
    return {
      type: 'address',
      status: 'unavailable',
      matches: [],
      screenedAt: new Date().toISOString(),
      errorMessageKey: 'errors.clientScreeningMissingAddress'
    };
  }

  /** Clears results, cancels in-flight checks and resets the note state (used on client change). */
  private resetScreeningState(): void {
    this.nameSubscription?.unsubscribe();
    this.addressSubscription?.unsubscribe();
    this.isNameLoading = false;
    this.isAddressLoading = false;
    this.nameScreeningResult = this.idleResult('name');
    this.addressScreeningResult = this.idleResult('address');
    this.noteSaved = false;
    this.noteMessageKey = null;
    this.isSavingNote = false;
  }
}

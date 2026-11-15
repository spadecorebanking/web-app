/**
 * Copyright since 2025 Mifos Initiative
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpBackend, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from 'environments/environment';
import {
  KycReadinessResult,
  BureauResponseDTO,
  AuditEntryDTO,
  SubmissionRecord,
  SubmissionRunResponse,
  DisputeCase,
  PagedResult,
  AuditParams,
  CbildRole
} from './credit-bureau.models';

/**
 * Basic-auth credentials for the three CB-ILD demo users, one per role,
 * already Base64-encoded as `user:password`.
 *
 * These are development credentials. They are compiled into the web app
 * bundle, so anyone who can load the app can read them. Before production,
 * replace them with a Fineract JWT or credentials supplied by the
 * environment.
 */
const CBILD_ROLE_CREDENTIALS: Record<string, string> = {
  KYC_OFFICER: btoa('kyc_officer:password'),
  CREDIT_ANALYST: btoa('credit_analyst:password'),
  COMPLIANCE: btoa('compliance:password')
};

/** sessionStorage key that holds the CB-ILD role the user last picked. */
const CBILD_ROLE_KEY = 'cbild_role';
/** sessionStorage key that holds the Base64 Basic-auth credentials for that role. */
const CBILD_CREDENTIALS_KEY = 'cbild_credentials';

/**
 * CB-ILD — Credit Bureau Information Lifecycle Dashboard
 * MSOC 2026 — Mifos Initiative
 *
 * Angular service connecting openMF/web-app to the CB-ILD Spring Boot backend.
 * Backend runs on port 8084 (configured via environment.pluginBaseUrl).
 *
 * Uses HttpBackend to bypass Fineract interceptors — CB-ILD has its own
 * Basic auth users separate from Fineract (kyc_officer, credit_analyst, compliance).
 *
 * How roles work: the user picks a role in one of the CB-ILD panels
 * (bureau readiness, credit profile, disputes, reporting dashboard).
 * `setRole` saves the role and its credentials in sessionStorage, and every
 * request after that authenticates as that role's CB-ILD user. The choice
 * lasts until the browser tab closes and is shared by all CB-ILD panels.
 * The role switch is a convenience, not an access control: the panels only
 * hide actions, so the CB-ILD backend must decide what each user may do.
 *
 * Responses are not cached. Every call sends a new request.
 *
 * RFC tax ID is never logged, stored, or displayed in the frontend.
 *
 * @see https://github.com/openMF/mifos-x-credit-bureau-plugin/tree/main/cb-ild
 * @author Satyam Mishra — MSOC 2026
 */
@Injectable({ providedIn: 'root' })
export class CreditBureauService {
  /** Raw HTTP handler, with none of the app's interceptors. */
  private httpBackend = inject(HttpBackend);

  /**
   * HttpClient built on `httpBackend`, so CB-ILD requests skip the app's
   * interceptors. Those are written for Fineract: they can add the Fineract
   * tenant header and credentials, and the error interceptor shows a global
   * alert. CB-ILD uses its own Basic-auth users (see `getHeaders`), and each
   * panel shows its own error message.
   */
  private externalHttp = new HttpClient(this.httpBackend);

  /**
   * CB-ILD base URL from `PLUGIN_BASE_URL` (`environment.pluginBaseUrl`),
   * read once when the service is created.
   *
   * Logs a console warning when the URL is neither `http://localhost...` nor
   * HTTPS, because the Basic-auth header would then travel unencrypted. The
   * URL is still used: the warning does not block requests.
   */
  private baseUrl = (() => {
    const url = environment.pluginBaseUrl;
    if (!url.startsWith('http://localhost') && !url.startsWith('https://')) {
      console.warn('CB-ILD: pluginBaseUrl should use HTTPS in production');
    }
    return url;
  })();

  /**
   * Switches the CB-ILD user that later requests authenticate as.
   *
   * Saves the role and its Basic-auth credentials in sessionStorage, so the
   * choice lasts until the browser tab closes and every CB-ILD panel uses it.
   *
   * @param role Role picked by the user, for example `COMPLIANCE`.
   */
  setRole(role: CbildRole): void {
    sessionStorage.setItem(CBILD_ROLE_KEY, role);
    sessionStorage.setItem(CBILD_CREDENTIALS_KEY, CBILD_ROLE_CREDENTIALS[role]);
  }

  /**
   * Returns the role saved by `setRole`.
   *
   * Falls back to `CREDIT_ANALYST` when nothing is saved yet, or when the
   * saved value is not a known role (for example, if it was edited by hand in
   * the browser's storage).
   *
   * @returns The current CB-ILD role.
   */
  getRole(): CbildRole {
    const stored = sessionStorage.getItem(CBILD_ROLE_KEY);
    const validRoles: CbildRole[] = [
      'KYC_OFFICER',
      'CREDIT_ANALYST',
      'COMPLIANCE'
    ];
    return stored && validRoles.includes(stored as CbildRole) ? (stored as CbildRole) : 'CREDIT_ANALYST';
  }

  /**
   * Builds the headers sent with every CB-ILD request: Basic auth for the
   * current role, and a JSON content type.
   *
   * Uses the `CREDIT_ANALYST` credentials when no role has been saved, which
   * matches the default of `getRole`.
   *
   * @returns Headers for one CB-ILD request.
   */
  getHeaders(): HttpHeaders {
    const credentials = sessionStorage.getItem(CBILD_CREDENTIALS_KEY) || CBILD_ROLE_CREDENTIALS['CREDIT_ANALYST'];
    return new HttpHeaders({
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json'
    });
  }

  /**
   * Checks whether a client's record is complete enough to report to the
   * credit bureau.
   *
   * Calls `GET /api/clients/{clientId}/bureau-readiness`.
   *
   * @param clientId Fineract client id.
   * @returns A readiness score, whether the client is ready, the fields that
   *   are still missing, and the latest bureau score and risk band if a report
   *   has been pulled.
   */
  getBureauReadiness(clientId: number): Observable<KycReadinessResult> {
    return this.externalHttp.get<KycReadinessResult>(`${this.baseUrl}/api/clients/${clientId}/bureau-readiness`, {
      headers: this.getHeaders()
    });
  }

  /**
   * Returns one page of bureau submission records.
   *
   * Calls `GET /api/submissions/history`.
   *
   * @param page Zero-based page number.
   * @param size Number of records per page.
   * @param clientId When given, only that client's submissions are returned.
   *   When omitted, submissions for all clients are returned.
   * @returns A Spring HATEOAS page. The records are under the single key in
   *   `_embedded`, and `page` holds the totals.
   */
  getSubmissionHistory(page = 0, size = 20, clientId?: number): Observable<PagedResult<SubmissionRecord>> {
    let params = new HttpParams().set('page', page.toString()).set('size', size.toString());
    // `clientId` 0 is a valid id, so only null and undefined leave the filter out.
    if (clientId !== undefined && clientId !== null) {
      params = params.set('clientId', clientId.toString());
    }
    return this.externalHttp.get<PagedResult<SubmissionRecord>>(`${this.baseUrl}/api/submissions/history`, {
      headers: this.getHeaders(),
      params
    });
  }

  /**
   * Starts a submission run, which sends client data to the bureau.
   *
   * Calls `POST /api/submissions/run`.
   *
   * @param clientIds Clients to submit. When omitted or empty, the request body
   *   is `null` and the backend chooses the clients itself.
   * @returns A message and the number of clients in the run. The outcome for
   *   each client is read afterwards from `getSubmissionHistory`.
   */
  runSubmissions(clientIds?: number[]): Observable<SubmissionRunResponse> {
    return this.externalHttp.post<SubmissionRunResponse>(
      `${this.baseUrl}/api/submissions/run`,
      // An empty list is sent as `null` as well, so it means "backend decides"
      // and never "submit nobody".
      clientIds && clientIds.length > 0 ? { clientIds } : null,
      { headers: this.getHeaders() }
    );
  }

  /**
   * Returns the submissions that are scheduled for another attempt, for
   * example after the bureau could not be reached.
   *
   * Calls `GET /api/submissions/schedule`.
   *
   * @returns The scheduled submission records. This is a plain list, not a page.
   */
  getRetrySchedule(): Observable<SubmissionRecord[]> {
    return this.externalHttp.get<SubmissionRecord[]>(`${this.baseUrl}/api/submissions/schedule`, {
      headers: this.getHeaders()
    });
  }

  /**
   * Records a credit inquiry (a bureau "pull") made for a client.
   *
   * Calls `POST /api/submissions/report-screening`.
   *
   * @param clientId Fineract client id.
   * @param loanId Loan the inquiry is for, or `null` when the inquiry is not
   *   tied to a loan.
   * @param inquiryType `HARD` for an inquiry made for a credit decision, or
   *   `SOFT` for a check that is not (for example a pre-qualification).
   * @returns The submission record created for the inquiry.
   */
  reportScreening(clientId: number, loanId: number | null, inquiryType: 'HARD' | 'SOFT'): Observable<SubmissionRecord> {
    return this.externalHttp.post<SubmissionRecord>(
      `${this.baseUrl}/api/submissions/report-screening`,
      { clientId, loanId, inquiryType },
      { headers: this.getHeaders() }
    );
  }

  /**
   * Creates a submission record that reports a loan approval for the client.
   *
   * Calls `POST /api/submissions/report-approval`.
   *
   * @param clientId Fineract client id.
   * @param loanId Fineract id of the approved loan.
   * @returns The submission record created for the approval.
   */
  reportApproval(clientId: number, loanId: number): Observable<SubmissionRecord> {
    return this.externalHttp.post<SubmissionRecord>(
      `${this.baseUrl}/api/submissions/report-approval`,
      { clientId, loanId },
      { headers: this.getHeaders() }
    );
  }

  /**
   * Returns the credit report stored for a client: score, risk band,
   * delinquencies, tradelines, alerts, and when it was pulled and expires.
   *
   * Calls `GET /api/clients/{clientId}/bureau-response`.
   *
   * @param clientId Fineract client id.
   * @returns The stored bureau response.
   */
  getBureauResponse(clientId: number): Observable<BureauResponseDTO> {
    return this.externalHttp.get<BureauResponseDTO>(`${this.baseUrl}/api/clients/${clientId}/bureau-response`, {
      headers: this.getHeaders()
    });
  }

  /**
   * Opens a dispute about data that was reported to the bureau. A new
   * dispute starts in `OPEN`.
   *
   * Calls `POST /api/disputes`.
   *
   * @param submissionRecordId Submission whose reported data is disputed.
   * @param disputeDetails What the client says is wrong.
   * @returns The new dispute.
   */
  createDispute(submissionRecordId: number, disputeDetails: string): Observable<DisputeCase> {
    return this.externalHttp.post<DisputeCase>(
      `${this.baseUrl}/api/disputes`,
      { submissionRecordId, disputeDetails },
      { headers: this.getHeaders() }
    );
  }

  /**
   * Moves a dispute along its workflow: `OPEN` → `UNDER_REVIEW` → `RESOLVED`.
   * The disputes panel offers Resolve only to the `COMPLIANCE` role.
   *
   * Calls `PUT /api/disputes/{disputeId}/status`.
   *
   * @param disputeId Id of the dispute to update.
   * @param newStatus Target status, for example `UNDER_REVIEW`.
   * @param resolutionNotes How the dispute was settled. Used when resolving.
   * @returns The updated dispute.
   */
  updateDisputeStatus(disputeId: number, newStatus: string, resolutionNotes?: string): Observable<DisputeCase> {
    return this.externalHttp.put<DisputeCase>(
      `${this.baseUrl}/api/disputes/${disputeId}/status`,
      // Notes are sent only when non-empty, so an empty string is never saved
      // as the resolution.
      { newStatus, ...(resolutionNotes ? { resolutionNotes } : {}) },
      { headers: this.getHeaders() }
    );
  }

  /**
   * Returns one dispute by id.
   *
   * Calls `GET /api/disputes/{disputeId}`.
   *
   * @param disputeId Id of the dispute.
   * @returns The dispute, including the institution's and the bureau's
   *   summaries of the disputed data when available.
   */
  getDispute(disputeId: number): Observable<DisputeCase> {
    return this.externalHttp.get<DisputeCase>(`${this.baseUrl}/api/disputes/${disputeId}`, {
      headers: this.getHeaders()
    });
  }

  /**
   * Returns one page of the CB-ILD audit log for a client: who did what and
   * when, the result, and how long it took.
   *
   * Calls `GET /api/clients/{clientId}/audit-trail`.
   *
   * @param clientId Fineract client id.
   * @param params Paging defaults to page 0 with 20 entries. `startDate` and
   *   `endDate` are sent exactly as given (the audit trail panel uses local
   *   date-times such as `2026-08-01T00:00`), and each is sent only when set.
   * @returns A Spring HATEOAS page. The entries are in
   *   `_embedded.auditEntryDTOList`.
   */
  getAuditTrail(clientId: number, params: AuditParams = {}): Observable<PagedResult<AuditEntryDTO>> {
    let httpParams = new HttpParams()
      .set('page', (params.page ?? 0).toString())
      .set('size', (params.size ?? 20).toString());
    if (params.startDate) {
      httpParams = httpParams.set('startDate', params.startDate);
    }
    if (params.endDate) {
      httpParams = httpParams.set('endDate', params.endDate);
    }
    return this.externalHttp.get<PagedResult<AuditEntryDTO>>(`${this.baseUrl}/api/clients/${clientId}/audit-trail`, {
      headers: this.getHeaders(),
      params: httpParams
    });
  }
}

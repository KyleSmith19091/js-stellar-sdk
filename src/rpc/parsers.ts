import { xdr, Contract, SorobanDataBuilder } from '@stellar/stellar-base';
import { Api } from './api';

export function parseRawSendTransaction(
  r: Api.RawSendTransactionResponse
): Api.SendTransactionResponse {
  const { errorResultXdr, diagnosticEventsXdr } = r;
  delete r.errorResultXdr;
  delete r.diagnosticEventsXdr;

  if (errorResultXdr) {
    return {
      ...r,
      ...(
        diagnosticEventsXdr !== undefined &&
        diagnosticEventsXdr.length > 0 && {
          diagnosticEvents: diagnosticEventsXdr.map(
            evt => xdr.DiagnosticEvent.fromXDR(evt, 'base64')
          )
        }
      ),
      errorResult: xdr.TransactionResult.fromXDR(errorResultXdr, 'base64'),
    };
  }

  return { ...r } as Api.BaseSendTransactionResponse;
}

export function parseTransactionInfo(raw: Api.RawTransactionInfo | Api.RawGetTransactionResponse): Omit<Api.TransactionInfo, 'status'> {
  const meta = xdr.TransactionMeta.fromXDR(raw.resultMetaXdr!, 'base64');
  const info: Omit<Api.TransactionInfo, 'status'> = {
    ledger: raw.ledger!,
    createdAt: raw.createdAt!,
    applicationOrder: raw.applicationOrder!,
    feeBump: raw.feeBump!,
    envelopeXdr: xdr.TransactionEnvelope.fromXDR(raw.envelopeXdr!, 'base64'),
    resultXdr: xdr.TransactionResult.fromXDR(raw.resultXdr!, 'base64'),
    resultMetaXdr: meta,
  };

  if (meta.switch() === 3 && meta.v3().sorobanMeta() !== null) {
    info.returnValue = meta.v3().sorobanMeta()?.returnValue();
  }

  if ('diagnosticEventsXdr' in raw && raw.diagnosticEventsXdr) {
    info.diagnosticEventsXdr = raw.diagnosticEventsXdr.map(
        diagnosticEvent => xdr.DiagnosticEvent.fromXDR(diagnosticEvent, 'base64')
    );
  }

  return info;
}

export function parseRawTransactions(
    r: Api.RawTransactionInfo
): Api.TransactionInfo {
  return {
    status: r.status,
    ...parseTransactionInfo(r),
  };
}

export function parseRawEvents(
  r: Api.RawGetEventsResponse
): Api.GetEventsResponse {
  return {
    latestLedger: r.latestLedger,
    events: (r.events ?? []).map((evt) => {
      const clone: Omit<Api.RawEventResponse, 'contractId'> = { ...evt };
      delete (clone as any).contractId; // `as any` hack because contractId field isn't optional

      // the contractId may be empty so we omit the field in that case
      return {
        ...clone,
        ...(evt.contractId !== '' && { contractId: new Contract(evt.contractId) }),
        topic: evt.topic.map((topic) => xdr.ScVal.fromXDR(topic, 'base64')),
        value: xdr.ScVal.fromXDR(evt.value, 'base64')
      };
    })
  };
}

export function parseRawLedgerEntries(
  raw: Api.RawGetLedgerEntriesResponse
): Api.GetLedgerEntriesResponse {
  return {
    latestLedger: raw.latestLedger,
    entries: (raw.entries ?? []).map((rawEntry) => {
      if (!rawEntry.key || !rawEntry.xdr) {
        throw new TypeError(
          `invalid ledger entry: ${JSON.stringify(rawEntry)}`
        );
      }

      return {
        lastModifiedLedgerSeq: rawEntry.lastModifiedLedgerSeq,
        key: xdr.LedgerKey.fromXDR(rawEntry.key, 'base64'),
        val: xdr.LedgerEntryData.fromXDR(rawEntry.xdr, 'base64'),
        ...(rawEntry.liveUntilLedgerSeq !== undefined && {
          liveUntilLedgerSeq: rawEntry.liveUntilLedgerSeq
        })
      };
    })
  };
}

function parseSuccessful(
  sim: Api.RawSimulateTransactionResponse,
  partial: Api.BaseSimulateTransactionResponse
):
  | Api.SimulateTransactionRestoreResponse
  | Api.SimulateTransactionSuccessResponse {
  // success type: might have a result (if invoking) and...
  const success: Api.SimulateTransactionSuccessResponse = {
    ...partial,
    transactionData: new SorobanDataBuilder(sim.transactionData!),
    minResourceFee: sim.minResourceFee!,
    cost: sim.cost!,
    ...// coalesce 0-or-1-element results[] list into a single result struct
    // with decoded fields if present
    // eslint-disable-next-line no-self-compare
    ((sim.results?.length ?? 0 > 0) && {
      result: sim.results!.map((row) => ({
          auth: (row.auth ?? []).map((entry) =>
            xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64')
          ),
          // if return value is missing ("falsy") we coalesce to void
          retval: row.xdr
            ? xdr.ScVal.fromXDR(row.xdr, 'base64')
            : xdr.ScVal.scvVoid()
        }))[0]
    }),

    // eslint-disable-next-line no-self-compare
    ...(sim.stateChanges?.length ?? 0 > 0) && {
      stateChanges: sim.stateChanges?.map((entryChange) => ({
          type: entryChange.type,
          key: xdr.LedgerKey.fromXDR(entryChange.key, 'base64'),
          before: entryChange.before ? xdr.LedgerEntry.fromXDR(entryChange.before, 'base64') : null,
          after: entryChange.after ? xdr.LedgerEntry.fromXDR(entryChange.after, 'base64') : null,
        }))
    }

  };

  if (!sim.restorePreamble || sim.restorePreamble.transactionData === '') {
    return success;
  }

  // ...might have a restoration hint (if some state is expired)
  return {
    ...success,
    restorePreamble: {
      minResourceFee: sim.restorePreamble!.minResourceFee,
      transactionData: new SorobanDataBuilder(
        sim.restorePreamble!.transactionData
      )
    }
  };
}

/**
 * Converts a raw response schema into one with parsed XDR fields and a
 * simplified interface.
 * Warning: This API is only exported for testing purposes and should not be
 *          relied on or considered "stable".
 *
 * @param {Api.SimulateTransactionResponse|Api.RawSimulateTransactionResponse} sim the raw response schema (parsed ones are allowed, best-effort
 *    detected, and returned untouched)
 *
 * @returns the original parameter (if already parsed), parsed otherwise
 *
 */
export function parseRawSimulation(
  sim:
    | Api.SimulateTransactionResponse
    | Api.RawSimulateTransactionResponse
): Api.SimulateTransactionResponse {
  const looksRaw = Api.isSimulationRaw(sim);
  if (!looksRaw) {
    // Gordon Ramsey in shambles
    return sim;
  }

  // shared across all responses
  const base: Api.BaseSimulateTransactionResponse = {
    _parsed: true,
    id: sim.id,
    latestLedger: sim.latestLedger,
    events:
      sim.events?.map((evt) => xdr.DiagnosticEvent.fromXDR(evt, 'base64')) ?? []
  };

  // error type: just has error string
  if (typeof sim.error === 'string') {
    return {
      ...base,
      error: sim.error
    };
  }

  return parseSuccessful(sim, base);
}

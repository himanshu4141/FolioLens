import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  FileSystemUploadType,
  getInfoAsync,
  uploadAsync,
} from 'expo-file-system/legacy';
import { authClient } from '@/src/lib/auth';
import { analytics } from '@/src/lib/analytics';
import { bucketBytes, bucketCount } from '@/src/lib/uxTelemetry';

export interface CasUploadResult {
  funds: number;
  /** Backward-compatible alias for transactionsAdded. */
  transactions: number;
  transactionsAdded: number;
  transactionsAlreadyPresent: number;
  transactionsRejected: number;
  transactionsRemoved: number;
}

export class CasUploadError extends Error {
  readonly result: CasUploadResult;

  constructor(message: string, result: CasUploadResult) {
    super(message);
    this.name = 'CasUploadError';
    this.result = result;
  }
}

interface UploadResponse {
  funds?: number;
  transactions?: number;
  transactions_added?: number;
  transactions_already_present?: number;
  transactions_rejected?: number;
  transactions_removed?: number;
  error?: string;
}

function exactCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function uploadResult(body: UploadResponse): CasUploadResult {
  const transactionsAdded = exactCount(body.transactions_added ?? body.transactions);
  return {
    funds: exactCount(body.funds),
    transactions: transactionsAdded,
    transactionsAdded,
    transactionsAlreadyPresent: exactCount(body.transactions_already_present),
    transactionsRejected: exactCount(body.transactions_rejected),
    transactionsRemoved: exactCount(body.transactions_removed),
  };
}

/**
 * Upload a CAS PDF to the parse-cas-pdf Supabase Edge Function.
 *
 * Used both by the onboarding wizard (Step 3 - Upload path) and by the
 * standalone /onboarding/pdf screen and the onboarding import wizard.
 *
 * Throws with a user-facing message on any failure (auth, network, parse,
 * server-side error). Callers should surface `error.message` directly.
 */
export async function uploadCasPdf(
  asset: DocumentPicker.DocumentPickerAsset,
  customPassword?: string,
): Promise<CasUploadResult> {
  const { data: sessionData } = await authClient.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) {
    console.warn('[cas-upload] no_session_token');
    throw new Error('Session expired. Please sign in again.');
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.error('[cas-upload] supabase_url_not_configured');
    throw new Error('Supabase URL is not configured.');
  }
  const url = `${supabaseUrl}/functions/v1/parse-cas-pdf`;

  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    console.error('[cas-upload] publishable_key_not_configured');
    throw new Error('Supabase publishable key is not configured.');
  }

  const trimmedPassword = customPassword?.trim() ? customPassword.trim() : undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    apikey: publishableKey,
    'Content-Type': 'application/octet-stream',
    'x-file-name': asset.name ?? 'cas.pdf',
    ...(trimmedPassword ? { 'x-password-override': trimmedPassword } : {}),
  };

  console.log('[cas-upload] dispatch', {
    platform: Platform.OS,
    file_size_bucket: bucketBytes(asset.size),
    has_password_override: !!trimmedPassword,
  });

  if (Platform.OS === 'web') {
    return uploadWebPdf(asset, url, headers);
  }
  return uploadNativePdf(asset, url, headers);
}

function parseUploadResponse(status: number, bodyText: string): CasUploadResult {
  let body: UploadResponse = {};
  let parseFailed = false;
  try {
    body = bodyText ? (JSON.parse(bodyText) as UploadResponse) : {};
  } catch {
    parseFailed = true;
  }

  if (parseFailed) {
    console.warn('[cas-upload] response_not_json', {
      status,
    });
    throw new Error(`Import failed (${status})`);
  }

  if (status >= 200 && status < 300) {
    const result = uploadResult(body);
    console.log('[cas-upload] response_ok', { status });
    analytics.track('portfolio_imported', {
      source: 'cas_pdf',
      funds_count_bucket: bucketCount(result.funds),
      transactions_count_bucket: bucketCount(result.transactionsAdded),
      already_present_count_bucket: bucketCount(result.transactionsAlreadyPresent),
      rejected_count_bucket: bucketCount(result.transactionsRejected),
      removed_count_bucket: bucketCount(result.transactionsRemoved),
    });
    return result;
  }

  console.warn('[cas-upload] response_error', {
    status,
  });
  throw new CasUploadError(body.error ?? `Import failed (${status})`, uploadResult(body));
}

async function readWebPdfBytes(asset: DocumentPicker.DocumentPickerAsset) {
  if (asset.file && typeof asset.file.arrayBuffer === 'function') {
    return asset.file.arrayBuffer();
  }

  try {
    const res = await fetch(asset.uri);
    if (!res.ok) {
      throw new Error(`Fetch read failed (status ${res.status})`);
    }
    return res.arrayBuffer();
  } catch (err) {
    throw new Error(`File read failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function uploadWebPdf(
  asset: DocumentPicker.DocumentPickerAsset,
  url: string,
  headers: Record<string, string>,
): Promise<CasUploadResult> {
  const pdfBytes = await readWebPdfBytes(asset);
  if (pdfBytes.byteLength === 0) {
    throw new Error('Selected PDF file is empty');
  }

  return new Promise<CasUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.responseType = 'text';
    xhr.onload = () => {
      try {
        resolve(parseUploadResponse(xhr.status, xhr.responseText));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed — could not reach server'));
    xhr.send(pdfBytes);
  });
}

async function uploadNativePdf(
  asset: DocumentPicker.DocumentPickerAsset,
  url: string,
  headers: Record<string, string>,
): Promise<CasUploadResult> {
  const info = await getInfoAsync(asset.uri);
  if (!info.exists || info.isDirectory) {
    throw new Error('File read failed: selected PDF is not available');
  }
  if (info.size === 0) {
    throw new Error('Selected PDF file is empty');
  }

  const response = await uploadAsync(url, asset.uri, {
    httpMethod: 'POST',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers,
  });

  return parseUploadResponse(response.status, response.body);
}

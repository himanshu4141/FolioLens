import { Platform } from 'react-native';
import {
  FileSystemUploadType,
  getInfoAsync,
  uploadAsync,
} from 'expo-file-system/legacy';
import { authClient } from '@/src/lib/auth';
import { uploadCasPdf } from '../casPdfUpload';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true });

jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  FileSystemUploadType: { BINARY_CONTENT: 'binary-content' },
  getInfoAsync: jest.fn(),
  uploadAsync: jest.fn(),
}));

jest.mock('@/src/lib/auth', () => ({
  __esModule: true,
  authClient: { getSession: jest.fn() },
}));

const mockedGetInfo = getInfoAsync as jest.MockedFunction<typeof getInfoAsync>;
const mockedUpload = uploadAsync as jest.MockedFunction<typeof uploadAsync>;
const mockedGetSession = authClient.getSession as jest.MockedFunction<
  typeof authClient.getSession
>;

type CasAsset = Parameters<typeof uploadCasPdf>[0];
const ASSET_NATIVE: CasAsset = {
  uri: 'file:///tmp/sample.pdf',
  name: 'sample.pdf',
  size: 12345,
  mimeType: 'application/pdf',
} as CasAsset;

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'pub-key-xyz';
  Platform.OS = 'ios';
  mockedGetSession.mockResolvedValue({
    data: { session: { access_token: 'token-abc' } },
  } as never);
});

afterAll(() => {
  process.env = ENV_BACKUP;
});

describe('uploadCasPdf — auth + config preconditions', () => {
  it('throws a session-expired error when there is no access token', async () => {
    mockedGetSession.mockResolvedValueOnce({ data: { session: null } } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow(/sign in again/i);
  });

  it('throws when EXPO_PUBLIC_SUPABASE_URL is unset', async () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow(/URL is not configured/);
  });

  it('throws when EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is unset', async () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow(/publishable key/);
  });
});

describe('uploadCasPdf — native path', () => {
  it('rejects when file does not exist', async () => {
    mockedGetInfo.mockResolvedValueOnce({ exists: false } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow(/not available/);
  });

  it('rejects when path is a directory', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: true,
    } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow(/not available/);
  });

  it('rejects when file is empty', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 0,
    } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow(/empty/);
  });

  it('returns parsed counts on a 200 response', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1024,
    } as never);
    mockedUpload.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ funds: 5, transactions: 42 }),
    } as never);

    const result = await uploadCasPdf(ASSET_NATIVE);

    expect(result).toEqual({ funds: 5, transactions: 42 });
    expect(mockedUpload).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/parse-cas-pdf',
      ASSET_NATIVE.uri,
      expect.objectContaining({
        httpMethod: 'POST',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: expect.objectContaining({
          Authorization: 'Bearer token-abc',
          apikey: 'pub-key-xyz',
          'Content-Type': 'application/octet-stream',
          'x-file-name': 'sample.pdf',
        }),
      }),
    );
    const headers = mockedUpload.mock.calls[0]![2]!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-password-override');
  });

  it('falls back to cas.pdf when asset has no name', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({ status: 200, body: '{}' } as never);
    await uploadCasPdf({ ...ASSET_NATIVE, name: undefined } as unknown as CasAsset);
    const headers = mockedUpload.mock.calls[0]![2]!.headers as Record<string, string>;
    expect(headers['x-file-name']).toBe('cas.pdf');
  });

  it('forwards a trimmed password override when supplied', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({ status: 200, body: '{}' } as never);
    await uploadCasPdf(ASSET_NATIVE, '  hunter2  ');
    const headers = mockedUpload.mock.calls[0]![2]!.headers as Record<string, string>;
    expect(headers['x-password-override']).toBe('hunter2');
  });

  it('omits password header when override is whitespace-only', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({ status: 200, body: '{}' } as never);
    await uploadCasPdf(ASSET_NATIVE, '   ');
    const headers = mockedUpload.mock.calls[0]![2]!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-password-override');
  });

  it('defaults missing counts to zero on 2xx with empty body', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({ status: 204, body: '' } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).resolves.toEqual({
      funds: 0,
      transactions: 0,
    });
  });

  it('surfaces server error message on 4xx', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({
      status: 422,
      body: JSON.stringify({ error: 'Invalid PDF password' }),
    } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow('Invalid PDF password');
  });

  it('surfaces a generic status-only message when error body has no error field', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({ status: 500, body: '{}' } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow('Import failed (500)');
  });

  it('surfaces a generic status-only message when body is not JSON', async () => {
    mockedGetInfo.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 1,
    } as never);
    mockedUpload.mockResolvedValueOnce({ status: 502, body: '<html></html>' } as never);
    await expect(uploadCasPdf(ASSET_NATIVE)).rejects.toThrow('Import failed (502)');
  });
});

describe('uploadCasPdf — web path', () => {
  let originalXHR: typeof XMLHttpRequest;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    Platform.OS = 'web';
    originalXHR = (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest })
      .XMLHttpRequest;
    originalFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest =
      originalXHR;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  function installXhr(scenario: 'load' | 'error', status = 200, body = '{}') {
    const send = jest.fn();
    const setRequestHeader = jest.fn();
    const open = jest.fn();
    const xhrInstance: Partial<XMLHttpRequest> & {
      onload?: () => void;
      onerror?: () => void;
      status: number;
      responseText: string;
      responseType: XMLHttpRequestResponseType;
    } = {
      open,
      send: ((bytes: ArrayBuffer) => {
        send(bytes);
        if (scenario === 'load') {
          xhrInstance.status = status;
          xhrInstance.responseText = body;
          xhrInstance.onload?.();
        } else {
          xhrInstance.onerror?.();
        }
      }) as XMLHttpRequest['send'],
      setRequestHeader,
      responseType: 'text',
      status: 0,
      responseText: '',
    };
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = jest
      .fn()
      .mockImplementation(() => xhrInstance);
    return { send, setRequestHeader, open };
  }

  function buildBlobAsset(bytes: number) {
    return {
      uri: 'blob:https://app.example/123',
      name: 'sample.pdf',
      size: bytes,
      mimeType: 'application/pdf',
      file: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)) },
    } as unknown as Parameters<typeof uploadCasPdf>[0];
  }

  it('uses asset.file.arrayBuffer when available', async () => {
    installXhr('load', 200, JSON.stringify({ funds: 1, transactions: 2 }));
    const result = await uploadCasPdf(buildBlobAsset(64));
    expect(result).toEqual({ funds: 1, transactions: 2 });
  });

  it('falls back to fetch().arrayBuffer() when asset.file is missing', async () => {
    const arrayBuffer = jest.fn().mockResolvedValue(new ArrayBuffer(4));
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, arrayBuffer } as never);
    installXhr('load', 200, '{}');
    const asset = {
      uri: 'blob:https://app.example/abc',
      name: 'sample.pdf',
    } as unknown as Parameters<typeof uploadCasPdf>[0];
    const result = await uploadCasPdf(asset);
    expect(result).toEqual({ funds: 0, transactions: 0 });
    expect(arrayBuffer).toHaveBeenCalled();
  });

  it('rejects when fetch fallback returns a non-ok response', async () => {
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 } as never);
    const asset = {
      uri: 'blob:https://app.example/abc',
      name: 'sample.pdf',
    } as unknown as Parameters<typeof uploadCasPdf>[0];
    await expect(uploadCasPdf(asset)).rejects.toThrow(/File read failed/);
  });

  it('rejects when fetch fallback throws', async () => {
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down'));
    const asset = {
      uri: 'blob:https://app.example/abc',
      name: 'sample.pdf',
    } as unknown as Parameters<typeof uploadCasPdf>[0];
    await expect(uploadCasPdf(asset)).rejects.toThrow(/network down/);
  });

  it('rejects when the selected file is empty (web)', async () => {
    await expect(uploadCasPdf(buildBlobAsset(0))).rejects.toThrow(/empty/);
  });

  it('rejects when the XHR errors out', async () => {
    installXhr('error');
    await expect(uploadCasPdf(buildBlobAsset(8))).rejects.toThrow(/could not reach server/);
  });

  it('rejects with server-provided error on a non-2xx XHR response', async () => {
    installXhr('load', 422, JSON.stringify({ error: 'Bad PDF' }));
    await expect(uploadCasPdf(buildBlobAsset(8))).rejects.toThrow('Bad PDF');
  });

  it('attaches the auth + apikey + filename headers via setRequestHeader', async () => {
    const { setRequestHeader, open } = installXhr('load', 200, '{}');
    await uploadCasPdf(buildBlobAsset(8));
    expect(open).toHaveBeenCalledWith(
      'POST',
      'https://example.supabase.co/functions/v1/parse-cas-pdf',
    );
    const headerNames = setRequestHeader.mock.calls.map((c) => c[0]);
    expect(headerNames).toEqual(
      expect.arrayContaining(['Authorization', 'apikey', 'Content-Type', 'x-file-name']),
    );
  });
});

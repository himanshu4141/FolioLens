import { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useSession } from '@/src/hooks/useSession';
import { useUserProfile } from '@/src/hooks/useUserProfile';
import { FolioLensLogo } from '@/src/components/clearLens/FolioLensLogo';
import { DesktopFormFrame } from '@/src/components/responsive';
import { useClearLensTokens } from '@/src/context/ThemeContext';
import {
  ClearLensRadii,
  ClearLensShadow,
  ClearLensSpacing,
  ClearLensTypography,
  type ClearLensTokens,
} from '@/src/constants/clearLensTheme';
import { uploadCasPdf } from '@/src/utils/casPdfUpload';

type UploadState = 'idle' | 'picking' | 'uploading' | 'success' | 'error';

export default function PDFScreen() {
  const router = useRouter();
  const { session } = useSession();
  const tokens = useClearLensTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const cl = tokens.colors;
  const [state, setState] = useState<UploadState>('idle');
  const [result, setResult] = useState<{ funds: number; transactions: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [customPassword, setCustomPassword] = useState('');

  const { data: profile } = useUserProfile(session?.user.id);

  const dobMissing = !profile?.dob;

  function goBackToImportOptions() {
    router.replace('/onboarding');
  }

  async function handlePickAndUpload() {
    setState('picking');
    setErrorMsg(null);
    setResult(null);

    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        base64: false,
      });
    } catch {
      setState('idle');
      return;
    }

    if (picked.canceled || !picked.assets?.[0]) {
      setState('idle');
      return;
    }

    const asset = picked.assets[0];
    setState('uploading');

    try {
      const uploadResult = await uploadCasPdf(asset, customPassword);
      setResult({ funds: uploadResult.funds, transactions: uploadResult.transactions });
      setState('success');
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Unknown error';
      const msg = /read/i.test(raw)
        ? 'Could not read the PDF file. Please re-download it and try again.'
        : raw;
      setErrorMsg(msg);
      setState('error');
    }
  }

  return (
    <DesktopFormFrame>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={[styles.hero, styles.heroClearLens]}>
          <FolioLensLogo size={44} showWordmark showTagline />
          <View style={styles.heroCopy}>
            <Text style={styles.title}>Upload a CAS PDF</Text>
            <Text style={styles.subtitle}>
              Use this when you already downloaded your statement and want to import it directly.
            </Text>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionLabel}>Supported PDFs</Text>
          <Text style={styles.infoTitle}>Detailed CAS statements we can import</Text>
          <Text style={styles.infoItem}>• CAMS CAS (password = your PAN)</Text>
          <Text style={styles.infoItem}>• KFintech / Karvy CAS (password = your PAN)</Text>
          <Text style={styles.infoItem}>• MFcentral CAS (password = your PAN)</Text>
          <Text style={styles.infoItem}>• CDSL CAS (password = PAN + date of birth, e.g. ABCPE1234F01011990)</Text>
          <Text style={styles.infoItem}>• NSDL CAS (password = PAN + date of birth, e.g. ABCPE1234F01011990)</Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionLabel}>Get the file</Text>
          <Text style={styles.howTitle}>Download your CAS from the source</Text>
          <Text style={styles.howStep}>
            <Text style={styles.bold}>CAMS: </Text>
            camsonline.com → Statements → CAS → Detailed → Download PDF
          </Text>
          <Text style={styles.howStep}>
            <Text style={styles.bold}>KFintech: </Text>
            kfintech.com → MF → CAS → Request → Download PDF
          </Text>
          <Text style={styles.howStep}>
            <Text style={styles.bold}>MFcentral: </Text>
            mfcentral.com → CAS → Detailed → Download PDF
          </Text>
          <Text style={styles.howStep}>
            <Text style={styles.bold}>CDSL: </Text>
            cvlkra.com → CAS → Request → Download PDF
          </Text>
          <Text style={styles.howStep}>
            <Text style={styles.bold}>NSDL: </Text>
            eservices.nsdl.com → CAS → Request → Download PDF
          </Text>
        </View>

        <View style={styles.panNote}>
          <Text style={styles.panNoteText}>
            For CAMS/KFintech/MFCentral: PDF password = your PAN.{'\n'}
            For CDSL/NSDL: PDF password = PAN + date of birth (set both in Settings → Account).
          </Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionLabel}>Custom password</Text>
          <Text style={styles.infoTitle}>Different PDF password?</Text>
          <Text style={styles.infoItem}>
            Leave this blank — your PAN (and date of birth for CDSL/NSDL) are used automatically.
            Only fill this in if your PDF was sent with a different password.
          </Text>
          <TextInput
            style={styles.passwordInput}
            placeholder="Enter PDF password"
            placeholderTextColor={cl.textSecondary}
            value={customPassword}
            onChangeText={setCustomPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={state !== 'uploading'}
          />
        </View>

        {dobMissing && (
          <View style={styles.dobWarning}>
            <Text style={styles.dobWarningTitle}>Date of birth not set</Text>
            <Text style={styles.dobWarningText}>
              CDSL/NSDL imports require your date of birth. Add it in Settings → Account.
            </Text>
            <TouchableOpacity
              style={styles.dobWarningBtn}
              onPress={() => router.push('/(tabs)/settings/account')}
            >
              <Text style={styles.dobWarningBtnText}>Go to Account Settings</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === 'success' && result && (
          <View style={styles.successCard}>
            <Text style={styles.successTitle}>Import complete</Text>
            <Text style={styles.successText}>
              {result.funds} fund{result.funds !== 1 ? 's' : ''} ·{' '}
              {result.transactions} transaction{result.transactions !== 1 ? 's' : ''} imported
            </Text>
            <TouchableOpacity style={styles.doneBtn} onPress={goBackToImportOptions}>
              <Text style={styles.doneBtnText}>Back to import setup</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === 'error' && errorMsg && (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Import failed</Text>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}

        {state !== 'success' && (
          <TouchableOpacity
            style={[
              styles.uploadBtn,
              (state === 'picking' || state === 'uploading') && styles.uploadBtnDisabled,
            ]}
            onPress={handlePickAndUpload}
            disabled={state === 'picking' || state === 'uploading'}
          >
            {state === 'uploading' ? (
              <>
                <ActivityIndicator color="#fff" style={{ marginRight: 8 }} />
                <Text style={styles.uploadBtnText}>Importing PDF…</Text>
              </>
            ) : (
              <Text style={styles.uploadBtnText}>
                {state === 'error' ? 'Try again' : 'Choose PDF'}
              </Text>
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.backLink} onPress={goBackToImportOptions}>
          <Text style={styles.backLinkText}>Back to import options</Text>
        </TouchableOpacity>
      </ScrollView>
    </DesktopFormFrame>
  );
}

function makeStyles(tokens: ClearLensTokens) {
  const cl = tokens.colors;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: cl.background },
    content: {
      paddingBottom: ClearLensSpacing.xxl,
      paddingTop: ClearLensSpacing.md,
      gap: ClearLensSpacing.md,
    },
    hero: {
      paddingTop: ClearLensSpacing.lg,
      paddingHorizontal: ClearLensSpacing.lg,
      paddingBottom: ClearLensSpacing.lg,
      gap: ClearLensSpacing.md,
    },
    heroClearLens: {
      margin: ClearLensSpacing.md,
      marginBottom: 0,
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.lg,
      ...ClearLensShadow,
    },
    heroCopy: { gap: ClearLensSpacing.sm },
    title: { ...ClearLensTypography.h1, color: cl.textPrimary, fontWeight: '700' },
    subtitle: { ...ClearLensTypography.body, color: cl.textSecondary },

    panel: {
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: cl.surface,
      borderWidth: 1,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.lg,
      gap: ClearLensSpacing.sm,
      ...ClearLensShadow,
    },
    sectionLabel: { ...ClearLensTypography.label, color: cl.emerald, textTransform: 'uppercase' },
    infoTitle: { ...ClearLensTypography.h3, color: cl.textPrimary, fontWeight: '700' },
    infoItem: { ...ClearLensTypography.bodySmall, color: cl.textSecondary },

    howTitle: { ...ClearLensTypography.h3, color: cl.textPrimary, fontWeight: '700' },
    howStep: { ...ClearLensTypography.bodySmall, color: cl.textSecondary },
    bold: { fontWeight: '700' },

    passwordInput: {
      borderWidth: 1,
      borderColor: cl.border,
      borderRadius: ClearLensRadii.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: cl.textPrimary,
      backgroundColor: cl.background,
      marginTop: 4,
    },
    panNote: {
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: cl.positiveBg,
      borderWidth: 1,
      borderColor: cl.mint,
      borderRadius: ClearLensRadii.lg,
      padding: 14,
    },
    panNoteText: { ...ClearLensTypography.bodySmall, color: cl.navy },

    successCard: {
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: cl.positiveBg,
      borderWidth: 1,
      borderColor: cl.mint,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.lg,
      gap: ClearLensSpacing.sm,
      alignItems: 'center',
    },
    successTitle: { ...ClearLensTypography.h3, color: cl.navy },
    successText: { ...ClearLensTypography.body, color: cl.navy, textAlign: 'center' },
    doneBtn: {
      backgroundColor: cl.emerald,
      borderRadius: ClearLensRadii.full,
      paddingVertical: 10, paddingHorizontal: 24, marginTop: 4,
    },
    doneBtnText: { color: cl.textOnDark, fontWeight: '700', fontSize: 14 },

    errorCard: {
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: cl.negativeBg,
      borderWidth: 1,
      borderColor: cl.negative,
      borderRadius: ClearLensRadii.lg,
      padding: 14,
      gap: 6,
    },
    errorTitle: { fontSize: 14, fontWeight: '700', color: cl.negative },
    errorText: { ...ClearLensTypography.bodySmall, color: cl.negative },

    uploadBtn: {
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: cl.emerald,
      borderRadius: ClearLensRadii.full,
      paddingVertical: 14,
      alignItems: 'center', flexDirection: 'row', justifyContent: 'center',
    },
    uploadBtnDisabled: { opacity: 0.6 },
    uploadBtnText: { color: cl.textOnDark, fontWeight: '700', fontSize: 15 },

    backLink: { alignItems: 'center', paddingVertical: 4 },
    backLinkText: { fontSize: 14, color: cl.emerald, fontWeight: '600' },

    dobWarning: {
      marginHorizontal: ClearLensSpacing.md,
      backgroundColor: cl.warningBg,
      borderWidth: 1,
      borderColor: cl.amber,
      borderRadius: ClearLensRadii.lg,
      padding: ClearLensSpacing.md,
      gap: 8,
    },
    dobWarningTitle: { fontSize: 14, fontWeight: '700', color: cl.warning },
    dobWarningText: { ...ClearLensTypography.bodySmall, color: cl.textSecondary },
    dobWarningBtn: {
      backgroundColor: cl.amber,
      borderRadius: ClearLensRadii.full,
      paddingVertical: 8,
      paddingHorizontal: 16,
      alignSelf: 'flex-start' as const,
    },
    dobWarningBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  });
}

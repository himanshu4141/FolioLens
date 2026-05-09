import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { analytics } from '@/src/lib/analytics';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-phase exceptions anywhere below this point. We mount it
 * once, at the very top of the React tree in `app/_layout.tsx`, so a
 * thrown error in any screen surfaces a recoverable Clear Lens fallback
 * instead of a white screen.
 *
 * The boundary is themed against light tokens to keep the bundle small —
 * by the time we render this fallback the theme provider may itself be in
 * a broken state, so we cannot rely on `useClearLensTokens()` here.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    analytics.captureException(error, {
      $exception_source: 'react_error_boundary',
      component_stack: info.componentStack ?? null,
    });
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <View style={styles.iconWrap}>
            <Ionicons name="warning-outline" size={32} color="#B91C1C" />
          </View>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            FolioLens hit an unexpected error. The team has been notified — try again, or restart
            the app if it keeps happening.
          </Text>
          <Pressable style={styles.button} onPress={this.handleReset}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: '#FAFBFD',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEEDEE',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#0A1430',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: '#4F5C75',
    textAlign: 'center',
    maxWidth: 320,
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: '#0A1430',
    marginTop: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});

export default ErrorBoundary;

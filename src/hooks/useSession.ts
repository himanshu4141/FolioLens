import { useSessionContext } from '@/src/context/SessionContext';

export function useSession() {
  return useSessionContext();
}

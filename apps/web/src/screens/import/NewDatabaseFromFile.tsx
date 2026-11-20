import { ImportFlow } from './ImportDialog';

export interface NewDatabaseFromFileProps {
  documentImport?: boolean;
  onClose: () => void;
  onDone: (databaseId: string) => void;
}
export function NewDatabaseFromFile(props: NewDatabaseFromFileProps) {
  return <ImportFlow {...props} />;
}

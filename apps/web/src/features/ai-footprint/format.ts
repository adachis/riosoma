import { useLingui } from '@lingui/react/macro';
import type { AiFeature, AiRange } from '@riosoma/contracts';
import { useFootprintSummaryFormat } from './summary-format';

export function useFootprintFormat() {
  const { t } = useLingui();
  const format = useFootprintSummaryFormat();
  return {
    ...format,
    /** "about 0.4 to 0.9 Wh and 0.1 to 0.3 g CO2e" */
    both(footprint: { energyWh: AiRange; gwpG: AiRange }) {
      const power = format.energy(footprint.energyWh);
      const co2 = format.carbon(footprint.gwpG);
      return t({ id: 'ai.footprint.both', message: `about ${power} and ${co2}` });
    },
    feature(feature: AiFeature) {
      switch (feature) {
        case 'embedding':
          return t({ id: 'knowledge.embeddings', message: 'Embeddings' });
        case 'search':
          return t({ id: 'knowledge.webSearch', message: 'Web search' });
        case 'rio':
          return t({ id: 'ai.feature.rio', message: 'Rio replies' });
        case 'aiFields':
          return t({ id: 'ai.feature.aiFields', message: 'AI fields' });
        case 'ingest':
          return t({ id: 'ai.feature.ingest', message: 'Ingest' });
        case 'diagnose':
          return t({ id: 'ai.feature.diagnose', message: 'Diagnose' });
        case 'automations':
          return t({ id: 'ai.feature.automations', message: 'Automations' });
        case 'routines':
          return t({ id: 'ai.feature.routines', message: 'Routines' });
      }
    },
  };
}

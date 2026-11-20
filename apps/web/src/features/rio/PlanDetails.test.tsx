import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { renderSharing } from '../../screens/database/share/testing';
import { PlanDetails } from './PlanDetails';

afterEach(cleanup);

it('lets keyboard users focus and read scrollable consequential settings', async () => {
  const configuration = JSON.stringify(
    { steps: Array.from({ length: 20 }, (_, index) => ({ id: index, kind: 'updateRecord' })) },
    null,
    2,
  );
  const app = renderSharing(<PlanDetails details={[{ kind: 'automation.create', configuration }]} />);
  const details = screen.getByRole('region', { name: 'Changes to review' });
  expect(details.textContent).toBe(configuration);
  await userEvent.tab();
  expect(document.activeElement).toBe(details);
  app.client.clear();
});

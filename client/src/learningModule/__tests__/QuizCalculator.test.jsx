import React from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '../../test/renderWithProviders';
import QuizCalculator from '../components/QuizCalculator';

/**
 * The keypad is the half of the calculator the evaluator tests cannot reach:
 * a key that types the wrong symbol is invisible to them, and so is a panel a
 * student cannot get open in the middle of a timed paper.
 */

const open = async () => {
  const user = userEvent.setup();
  renderWithProviders(<QuizCalculator />);
  await user.click(screen.getByRole('button', { name: /calculator/i }));
  return user;
};

const press = async (user, ...labels) => {
  for (const label of labels) {
    // eslint-disable-next-line no-await-in-loop
    await user.click(screen.getByRole('button', { name: label }));
  }
};

describe('learningModule <QuizCalculator />', () => {
  it('stays out of the way until it is asked for', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QuizCalculator />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /calculator/i }));
    expect(screen.getByRole('dialog', { name: /scientific calculator/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close the calculator/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('types what the keys say and works the answer out', async () => {
    const user = await open();

    await press(user, '7', 'multiply', '8', 'equals');
    expect(screen.getByLabelText('Calculation')).toHaveValue('7×8');
    expect(screen.getByText('56')).toBeInTheDocument();
  });

  it('starts in degrees and can be switched to radians', async () => {
    const user = await open();

    await press(user, 'sine', '3', '0', 'close bracket', 'equals');
    expect(screen.getByText('0.5')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /switch to radians/i }));
    await press(user, 'equals');
    expect(screen.getByText('-0.988031624093')).toBeInTheDocument();
  });

  it('names what went wrong instead of showing a stray number', async () => {
    const user = await open();

    await press(user, '1', 'divide', '0', 'equals');
    expect(screen.getByText(/divide by zero/i)).toBeInTheDocument();
  });

  it('carries a result into the next calculation', async () => {
    const user = await open();

    await press(user, '4', 'plus', '4', 'equals', 'clear', 'previous answer', 'multiply', '3', 'equals');
    expect(screen.getByText('24')).toBeInTheDocument();
  });
});

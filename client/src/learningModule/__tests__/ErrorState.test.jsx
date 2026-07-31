import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ErrorState } from '../components/common';

/**
 * A student turned away from a quiz has to be able to tell *which* thing is
 * wrong — their account has no learning role, or they are simply not on this
 * subject's roll — because the two have completely different fixes. These tests
 * pin the branch that decides that, and the fact that a refusal is never offered
 * a "Try again" that cannot possibly work.
 *
 * The wording itself is the server's (middleware/lmAuth.js loadClass), so it can
 * name the subject; only the code and the title live here.
 */

const denial = (code, message) => ({ status: 403, message, payload: { code } });

describe('learningModule <ErrorState />', () => {
  it('explains a missing platform role rather than reporting a failure', () => {
    render(
      <ErrorState
        error={denial('ROLE_REQUIRED', 'You do not have the necessary role to open these pages.')}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(/do not have the necessary role for these pages/i)).toBeInTheDocument();
    expect(screen.getByText(/necessary role to open these pages/i)).toBeInTheDocument();
    expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
  });

  it('names the subject when the account is fine but the enrolment is not', () => {
    render(
      <ErrorState
        error={denial(
          'NOT_ENROLLED',
          'You do not have the necessary access to Signals & Systems (EC301) because you are not enrolled in this subject.',
        )}
      />,
    );

    expect(screen.getByText(/do not have access to this subject/i)).toBeInTheDocument();
    expect(screen.getByText(/Signals & Systems \(EC301\)/)).toBeInTheDocument();
  });

  it('distinguishes an unapproved join request from having no enrolment at all', () => {
    render(
      <ErrorState
        error={denial('JOIN_PENDING', 'Your request to join Signals & Systems has not been approved yet.')}
      />,
    );

    expect(screen.getByText(/waiting for your teacher to approve you/i)).toBeInTheDocument();
  });

  it('still reports an ordinary failure as a retryable error', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={{ status: 500, message: 'Failed to load quizzes.' }} onRetry={onRetry} />);

    expect(screen.getByText('Failed to load quizzes.')).toBeInTheDocument();
    expect(screen.getByText(/try again/i)).toBeInTheDocument();
  });

  it('does not dress up a 403 it has no specific advice for', () => {
    render(<ErrorState error={denial(undefined, 'Only the class teacher can do that.')} />);

    expect(screen.getByText('Only the class teacher can do that.')).toBeInTheDocument();
    expect(screen.queryByText(/necessary role/i)).not.toBeInTheDocument();
  });
});

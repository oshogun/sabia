import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotesTile } from './NotesTile';

const SUBJECT = 'flight #1';

describe('NotesTile', () => {
  it('shows the empty state and an "Add notes" action with a subject-scoped accessible name', () => {
    render(<NotesTile kind="flight" subject={SUBJECT} notes={null} onSave={vi.fn()} />);

    expect(screen.getByText('No notes for this flight.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: `Add notes for ${SUBJECT}` });
    expect(button).toHaveTextContent('Add notes');
  });

  it('shows the empty state for a trip', () => {
    render(<NotesTile kind="trip" subject="Trip Seven" notes="" onSave={vi.fn()} />);
    expect(screen.getByText('No notes for this trip.')).toBeInTheDocument();
  });

  it('shows saved notes and a pencil icon-only button with a subject-scoped accessible name', () => {
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={vi.fn()} />);

    expect(screen.getByText('Bumpy approach.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` });
    // Icon-only: no separate visible text node inside besides the tooltip label used as its name.
    expect(button.textContent?.trim()).toBe('');
  });

  it('enters edit mode from the pencil button, pre-filled with the current notes', async () => {
    const user = userEvent.setup();
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Bumpy approach.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('enters edit mode from a double-click on the notes text', () => {
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={vi.fn()} />);

    fireEvent.doubleClick(screen.getByText('Bumpy approach.'));

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Bumpy approach.');
  });

  it('Escape exits edit mode without saving and restores the old value on the next edit', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'an abandoned draft' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Bumpy approach.');
  });

  it('Cancel exits edit mode without saving and restores the old value on the next edit', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'an abandoned draft' } });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Bumpy approach.');
  });

  it('Save sends the trimmed draft, never the untrimmed value', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  a new note  ' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('a new note'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Save with a blank draft sends null', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it('shows the rejection message inline, stays in edit mode and keeps the unsaved draft', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('network down'));
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved draft' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument());
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('unsaved draft');
  });

  it('moves focus to the Edit button after a successful save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<NotesTile kind="flight" subject={SUBJECT} notes="Bumpy approach." onSave={onSave} />);

    const editButton = screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` });
    await user.click(editButton);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a new note' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Edit notes for ${SUBJECT}` }));
  });

  it('moves focus to the Add/Edit button after Cancel', async () => {
    const user = userEvent.setup();
    render(<NotesTile kind="flight" subject={SUBJECT} notes={null} onSave={vi.fn()} />);

    const addButton = screen.getByRole('button', { name: `Add notes for ${SUBJECT}` });
    await user.click(addButton);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Add notes for ${SUBJECT}` }));
  });
});

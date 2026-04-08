import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from '../src/components/MessageBubble';

describe('MessageBubble', () => {
  it('renders user message on the right', () => {
    const { container } = render(<MessageBubble role="user" content="Hello" createdAt={new Date()} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('items-end');
  });

  it('renders assistant message on the left', () => {
    const { container } = render(<MessageBubble role="assistant" content="Hi there" createdAt={new Date()} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('items-start');
  });

  it('renders bold markdown in assistant messages', () => {
    render(<MessageBubble role="assistant" content="This is **bold**" createdAt={new Date()} />);
    const strong = document.querySelector('strong');
    expect(strong?.textContent).toBe('bold');
  });
});

import { normalizeTopicName, topicNameKey } from './topic-name.util';

describe('topic-name.util', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeTopicName('  REST   APIs  ')).toBe('REST APIs');
  });

  it('treats casing as the same topic key', () => {
    expect(topicNameKey('HTML & CSS')).toBe(topicNameKey('html & css'));
  });
});

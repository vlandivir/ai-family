insert into projects (name, slug, telegram_chat_id, telegram_topic_id, repo_url)
values (
  'Сербский',
  'serbian',
  -1003563449188,
  540,
  'https://github.com/vlandivir/ai-family-serbian'
);

update conversations
set project_id = projects.id
from projects
where projects.slug = 'serbian'
  and conversations.kind = 'topic'
  and conversations.telegram_chat_id = projects.telegram_chat_id
  and conversations.telegram_topic_id = projects.telegram_topic_id;

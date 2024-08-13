import { Box, Label, Link, Pagination, PastTime, Text } from '@/TabNewsUI';

export default function UserList({ userList, pagination }) {
  const listNumberStart = pagination.perPage * (pagination.currentPage - 1) + 1;

  return (
    <>
      <Box
        as="ol"
        sx={{
          display: 'grid',
          gap: '0.5rem',
          gridTemplateColumns: 'min-content minmax(0, 1fr)',
          padding: 0,
          margin: 0,
        }}
        key={`user-list-${listNumberStart}`}
        start={listNumberStart}>
        {userList.map((userObject) => (
          <UserListItem key={userObject.id} user={userObject} />
        ))}
      </Box>

      <Pagination {...pagination} />
    </>
  );
}

function UserListItem({ user }) {
  function getTabCoinsText(count) {
    return count > 1 || count < -1 ? `${count} tabcoins` : `${count} tabcoin`;
  }

  function formatUpdatedAt(date) {
    return `Atualizado há ${date}`;
  }

  return (
    <Box
      as="li"
      sx={{
        display: 'contents',
        ':before': {
          content: 'counter(list-item) "."',
          counterIncrement: 'list-item',
          fontWeight: 'semibold',
          width: 'min-content',
          marginLeft: 'auto',
        },
      }}>
      <Box>
        <Box sx={{ wordBreak: 'break-word' }}>
          <Link
            sx={{
              fontWeight: 'semibold',
              ':link': {
                color: 'fg.default',
              },
              ':visited': {
                color: 'fg.subtle',
              },
            }}
            href={`/${user.username}`}>
            {user.username}
            {user.features.includes('nuked') && (
              <Label variant="danger" sx={{ ml: 1 }}>
                nuked
              </Label>
            )}
          </Link>
        </Box>
        {user.description && (
          <Text sx={{ wordWrap: 'break-word', fontWeight: 'normal', fontStyle: 'italic', fontSize: 1 }}>
            {user.description}
          </Text>
        )}
        <Box
          sx={{
            display: 'grid',
            gap: 1,
            gridTemplateColumns:
              'max-content max-content max-content max-content minmax(20px, max-content) max-content max-content',
            fontSize: 0,
            whiteSpace: 'nowrap',
            color: 'neutral.emphasis',
          }}>
          <PastTime formatText={formatUpdatedAt} direction="ne" date={user.updated_at} />
          {' · '}
          <Text>{getTabCoinsText(user.tabcoins)}</Text>
          {' · '}
          <Text>{user.tabcash} tabcash</Text>
        </Box>
      </Box>
    </Box>
  );
}

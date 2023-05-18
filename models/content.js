import { v4 as uuidV4 } from 'uuid';
import slug from 'slug';
import database from 'infra/database.js';
import validator from 'models/validator.js';
import balance from 'models/balance.js';
import { ForbiddenError, NotFoundError, ValidationError } from 'errors/index.js';
import queries from 'models/queries';
import prestige from 'models/prestige';

async function findAll(values = {}, options = {}) {
  values = validateValues(values);
  const offset = (values.page - 1) * values.per_page;

  const query = {
    values: [],
  };

  if (!values.count) {
    query.values = [values.limit || values.per_page, offset];
  }

  if (options.strategy === 'relevant_global') {
    query.text = queries.rankedContent;
    if (values.count) {
      query.values = [1, 0];
    }

    const relevantResults = await database.query(query, { transaction: options.transaction });

    return relevantResults.rows;
  }

  const selectClause = buildSelectClause(values);
  const whereClause = buildWhereClause(values?.where);
  const orderByClause = buildOrderByClause(values);

  query.text = `
      WITH content_window AS (
      SELECT
        COUNT(*) OVER()::INTEGER as total_rows,
        id
      FROM contents
      ${whereClause}
      ${orderByClause}

      ${values.count ? 'LIMIT 1' : 'LIMIT $1 OFFSET $2'}
      )
      ${selectClause}
      ${orderByClause}
      ;`;

  if (values.where) {
    Object.keys(values.where).forEach((key) => {
      if (key === '$not_null') return;
      if (key === '$or') {
        values.where[key].forEach(($orObject) => {
          query.values.push(Object.values($orObject)[0]);
        });
      } else {
        query.values.push(values.where[key]);
      }
    });
  }
  const results = await database.query(query, { transaction: options.transaction });

  return results.rows;

  function validateValues(values) {
    const cleanValues = validator(values, {
      page: 'optional',
      per_page: 'optional',
      order: 'optional',
      where: 'optional',
      count: 'optional',
      limit: 'optional',
      attributes: 'optional',
    });

    return cleanValues;
  }

  function buildSelectClause(values) {
    if (values.count) {
      return `
        SELECT
          total_rows
        FROM
          content_window
        `;
    }

    return `
      SELECT
        contents.id,
        contents.owner_id,
        contents.parent_id,
        contents.slug,
        contents.title,
        ${!values?.attributes?.exclude?.includes('body') ? 'contents.body,' : ''}
        contents.status,
        contents.source_url,
        contents.created_at,
        contents.updated_at,
        contents.published_at,
        contents.deleted_at,
        users.username as owner_username,
        content_window.total_rows,
        get_current_balance('content:tabcoin', contents.id) as tabcoins,

        -- Originally this query returned a list of contents to the server and
        -- afterward made an additional roundtrip to the database for every item using
        -- the findChildrenCount() method to get the children count. Now we perform a
        -- subquery that is not performant but everything is embedded in one travel.
        -- https://github.com/filipedeschamps/tabnews.com.br/blob/de65be914f0fd7b5eed8905718e4ab286b10557e/models/content.js#L51
        (
          WITH RECURSIVE children AS (
            SELECT
                id,
                parent_id
            FROM
              contents as all_contents
            WHERE
              all_contents.parent_id = contents.id AND
              all_contents.status = 'published'
            UNION ALL
              SELECT
                all_contents.id,
                all_contents.parent_id
              FROM
                contents as all_contents
              INNER JOIN
                children ON all_contents.parent_id = children.id
              WHERE
                all_contents.status = 'published'
          )
          SELECT
            count(children.id)::integer
          FROM
            children
        ) as children_deep_count
      FROM
        contents
      INNER JOIN
        content_window ON contents.id = content_window.id
      INNER JOIN
        users ON contents.owner_id = users.id
    `;
  }

  function buildWhereClause(columns) {
    if (!columns) {
      return '';
    }

    let globalIndex = query.values.length;
    return Object.entries(columns).reduce((accumulator, column, index) => {
      if (index === 0) {
        return `WHERE ${getColumnDeclaration(column)}`;
      } else {
        return `${accumulator} AND ${getColumnDeclaration(column)}`;
      }

      function getColumnDeclaration(column) {
        const columnName = column[0];
        const columnValue = column[1];

        if (columnValue === null) {
          globalIndex += 1;
          return `contents.${columnName} IS NOT DISTINCT FROM $${globalIndex}`;
        }

        if (columnName === '$or') {
          const $orQuery = columnValue
            .map((orColumn) => {
              globalIndex += 1;
              const orColumnName = Object.keys(orColumn)[0];
              return `contents.${orColumnName} = $${globalIndex}`;
            })
            .join(' OR ');

          return `(${$orQuery})`;
        }

        if (columnName === '$not_null') {
          return columnValue.map((columnName) => `contents.${columnName} IS NOT NULL`).join(' AND ');
        }

        if (columnName === 'owner_username') {
          globalIndex += 1;
          return whereOwnerUsername(`$${globalIndex}`);
        }

        globalIndex += 1;
        return `contents.${columnName} = $${globalIndex}`;
      }
    }, '');
  }

  function buildOrderByClause({ order, count }) {
    if (!order || count) {
      return '';
    }

    return `ORDER BY contents.${order}`;
  }
}

async function findOne(values, options = {}) {
  values.limit = 1;
  const rows = await findAll(values, options);
  return rows[0];
}

async function findWithStrategy(options = {}) {
  const findAllInitTime = performance.now();
  let rankStartTime, rankEndTime;
  let strategy = options.strategy;

  const strategies = {
    new: getNew,
    old: getOld,
    relevant: getRelevant,
  };

  const queryReturn = await strategies[options.strategy](options);

  const findAllEndTime = performance.now();

  console.log({
    findWithStrategyTime: findAllEndTime - findAllInitTime,
    rankTime: rankEndTime - rankStartTime,
    ...options,
    strategy,
  });

  return queryReturn;

  async function getNew(options = {}) {
    const results = {};

    options.order = 'published_at DESC';
    results.rows = await findAll(options);
    options.totalRows = results.rows[0]?.total_rows;
    results.pagination = await getPagination(options);

    return results;
  }

  async function getOld(options = {}) {
    const results = {};

    options.order = 'published_at ASC';
    results.rows = await findAll(options);
    options.totalRows = results.rows[0]?.total_rows;
    results.pagination = await getPagination(options);

    return results;
  }

  async function getRelevant(values = {}) {
    const results = {};
    const options = {};

    if (!values?.where?.owner_username && !values?.where?.owner_id && values?.where?.parent_id === null) {
      options.strategy = 'relevant_global';
      strategy = 'relevant_global';
    }
    values.order = 'published_at DESC';

    const contentList = await findAll(values, options);

    if (options.strategy === 'relevant_global') {
      results.rows = contentList;
    } else {
      rankStartTime = performance.now();
      results.rows = rankContentListByRelevance(contentList);
      rankEndTime = performance.now();
    }

    values.totalRows = results.rows[0]?.total_rows;
    results.pagination = await getPagination(values, options);

    return results;
  }
}

async function getPagination(values, options = {}) {
  values.count = true;

  const totalRows = values.totalRows ?? (await findAll(values, options))[0]?.total_rows ?? 0;
  const perPage = values.per_page;
  const firstPage = 1;
  const lastPage = Math.ceil(totalRows / values.per_page);
  const nextPage = values.page >= lastPage ? null : values.page + 1;
  const previousPage = values.page <= 1 ? null : values.page > lastPage ? lastPage : values.page - 1;
  const strategy = values.strategy;

  return {
    currentPage: values.page,
    totalRows: totalRows,
    perPage: perPage,
    firstPage: firstPage,
    nextPage: nextPage,
    previousPage: previousPage,
    lastPage: lastPage,
    strategy: strategy,
  };
}

async function create(postedContent, options = {}) {
  populateSlug(postedContent);
  populateStatus(postedContent);
  const validContent = validateCreateSchema(postedContent);

  checkRootContentTitle(validContent);

  if (validContent.parent_id) {
    await checkIfParentIdExists(validContent, {
      transaction: options.transaction,
    });
  }

  populatePublishedAtValue(null, validContent);

  const newContent = await runInsertQuery(validContent, {
    transaction: options.transaction,
  });

  await creditOrDebitTabCoins(null, newContent, {
    eventId: options.eventId,
    transaction: options.transaction,
  });

  newContent.tabcoins = await balance.getTotal(
    {
      balanceType: 'content:tabcoin',
      recipientId: newContent.id,
    },
    {
      transaction: options.transaction,
    }
  );

  return newContent;

  async function runInsertQuery(content, options) {
    const query = {
      text: `
      WITH
        inserted_content as (
          INSERT INTO
            contents (parent_id, owner_id, slug, title, body, status, source_url, published_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        )
      SELECT
        inserted_content.id,
        inserted_content.owner_id,
        inserted_content.parent_id,
        inserted_content.slug,
        inserted_content.title,
        inserted_content.body,
        inserted_content.status,
        inserted_content.source_url,
        inserted_content.created_at,
        inserted_content.updated_at,
        inserted_content.published_at,
        inserted_content.deleted_at,
        users.username as owner_username
      FROM
        inserted_content
      INNER JOIN
        users ON inserted_content.owner_id = users.id
      ;`,
      values: [
        content.parent_id,
        content.owner_id,
        content.slug,
        content.title,
        content.body,
        content.status,
        content.source_url,
        content.published_at,
      ],
    };

    try {
      const results = await database.query(query, { transaction: options.transaction });
      return results.rows[0];
    } catch (error) {
      throw parseQueryErrorToCustomError(error);
    }
  }
}

function populateSlug(postedContent) {
  if (!postedContent.slug) {
    postedContent.slug = getSlug(postedContent.title) || uuidV4();
  }
}

function getSlug(title) {
  if (!title) {
    return;
  }

  slug.extend({
    '%': ' por cento',
    '>': '-',
    '<': '-',
    '@': '-',
    '.': '-',
    ',': '-',
    '&': ' e ',
    _: '-',
    '/': '-',
  });

  const generatedSlug = slug(title, {
    trim: true,
  });

  const truncatedSlug = generatedSlug.substring(0, 255);

  return truncatedSlug;
}

function populateStatus(postedContent) {
  postedContent.status = postedContent.status || 'draft';
}

async function checkIfParentIdExists(content, options) {
  const existingContent = await findOne(
    {
      where: {
        id: content.parent_id,
      },
    },
    options
  );

  if (!existingContent) {
    throw new ValidationError({
      message: `Você está tentando criar ou atualizar um sub-conteúdo para um conteúdo que não existe.`,
      action: `Utilize um "parent_id" que aponte para um conteúdo que existe.`,
      stack: new Error().stack,
      errorLocationCode: 'MODEL:CONTENT:CHECK_IF_PARENT_ID_EXISTS:NOT_FOUND',
      statusCode: 400,
      key: 'parent_id',
    });
  }
}

function parseQueryErrorToCustomError(error) {
  if (error.databaseErrorCode === database.errorCodes.UNIQUE_CONSTRAINT_VIOLATION) {
    return new ValidationError({
      message: `O conteúdo enviado parece ser duplicado.`,
      action: `Utilize um "title" ou "slug" diferente.`,
      stack: new Error().stack,
      errorLocationCode: 'MODEL:CONTENT:CHECK_FOR_CONTENT_UNIQUENESS:ALREADY_EXISTS',
      statusCode: 400,
      key: 'slug',
    });
  }

  return error;
}

function validateCreateSchema(content) {
  const cleanValues = validator(content, {
    parent_id: 'optional',
    owner_id: 'required',
    slug: 'required',
    title: 'optional',
    body: 'required',
    status: 'required',
    source_url: 'optional',
  });

  if (cleanValues.status === 'deleted') {
    throw new ValidationError({
      message: 'Não é possível criar um novo conteúdo diretamente com status "deleted".',
      key: 'status',
      type: 'any.only',
      errorLocationCode: 'MODEL:CONTENT:VALIDATE_CREATE_SCHEMA:STATUS_DELETED',
    });
  }

  return cleanValues;
}

function checkRootContentTitle(content) {
  if (!content.parent_id && !content.title) {
    throw new ValidationError({
      message: `"title" é um campo obrigatório.`,
      stack: new Error().stack,
      errorLocationCode: 'MODEL:CONTENT:CHECK_ROOT_CONTENT_TITLE:MISSING_TITLE',
      statusCode: 400,
      key: 'title',
    });
  }
}

function populatePublishedAtValue(oldContent, newContent) {
  if (oldContent && oldContent.published_at) {
    newContent.published_at = oldContent.published_at;
    return;
  }

  if (oldContent && !oldContent.published_at && newContent.status === 'published') {
    newContent.published_at = new Date();
    return;
  }

  if (!oldContent && newContent.status === 'published') {
    newContent.published_at = new Date();
    return;
  }
}

async function creditOrDebitTabCoins(oldContent, newContent, options = {}) {
  const contentDefaultEarnings = 1;

  // We should not credit or debit if the parent content is from the same user.
  if (newContent.parent_id) {
    const parentContent = await findOne(
      {
        where: {
          id: newContent.parent_id,
        },
      },
      options
    );

    if (parentContent.owner_id === newContent.owner_id) {
      return;
    }
  }

  // We should not credit or debit if the content has never been published before
  // and is being directly deleted, example: "draft" -> "deleted".
  if (oldContent && !oldContent.published_at && newContent.status === 'deleted') {
    return;
  }

  // We should debit if the content was once "published", but now is being "deleted".
  // 1) If content `tabcoins` is positive, we need to extract the `contentDefaultEarnings`
  // from it and then debit all additional tabcoins from the user, including `userEarnings`.
  // 2) If content `tabcoins` is negative, we should debit the original tabcoin gained from the
  // creation of the content represented in `userEarnings`.
  if (oldContent && oldContent.published_at && newContent.status === 'deleted') {
    let amountToDebit;

    const userEarnings = await prestige.getByContentId(oldContent.id, { transaction: options.transaction });

    if (oldContent.tabcoins > 0) {
      amountToDebit = contentDefaultEarnings - oldContent.tabcoins - userEarnings;
    } else {
      amountToDebit = -userEarnings;
    }

    await balance.create(
      {
        balanceType: 'user:tabcoin',
        recipientId: newContent.owner_id,
        amount: amountToDebit,
        originatorType: options.eventId ? 'event' : 'content',
        originatorId: options.eventId ? options.eventId : newContent.id,
      },
      {
        transaction: options.transaction,
      }
    );
    return;
  }

  if (
    // We should credit if the content is being created directly with "published" status.
    (!oldContent && newContent.published_at) ||
    // We should credit if the content already existed and is now being published for the first time.
    (oldContent && !oldContent.published_at && newContent.status === 'published')
  ) {
    const userEarnings = await prestige.getByUserId(newContent.owner_id, {
      isRoot: !newContent.parent_id,
      transaction: options.transaction,
    });

    if (userEarnings < 0) {
      throw new ForbiddenError({
        message: 'Não é possível publicar porque há outras publicações mal avaliadas que ainda não foram excluídas.',
        action: 'Exclua seus conteúdos mais recentes que estiverem classificados como não relevantes.',
        errorLocationCode: 'MODEL:CONTENT:CREDIT_OR_DEBIT_TABCOINS:NEGATIVE_USER_EARNINGS',
      });
    }

    await balance.create(
      {
        balanceType: 'user:tabcoin',
        recipientId: newContent.owner_id,
        amount: userEarnings,
        originatorType: options.eventId ? 'event' : 'content',
        originatorId: options.eventId ? options.eventId : newContent.id,
      },
      {
        transaction: options.transaction,
      }
    );

    await balance.create(
      {
        balanceType: 'content:tabcoin',
        recipientId: newContent.id,
        amount: contentDefaultEarnings,
        originatorType: options.eventId ? 'event' : 'content',
        originatorId: options.eventId ? options.eventId : newContent.id,
      },
      {
        transaction: options.transaction,
      }
    );
    return;
  }
}

async function update(contentId, postedContent, options = {}) {
  const validPostedContent = validateUpdateSchema(postedContent);

  const oldContent = await findOne(
    {
      where: {
        id: contentId,
      },
    },
    options
  );

  const newContent = { ...oldContent, ...validPostedContent };

  throwIfContentIsAlreadyDeleted(oldContent);
  throwIfContentPublishedIsChangedToDraft(oldContent, newContent);
  checkRootContentTitle(newContent);
  checkForParentIdRecursion(newContent);

  if (newContent.parent_id) {
    await checkIfParentIdExists(newContent, {
      transaction: options.transaction,
    });
  }

  populatePublishedAtValue(oldContent, newContent);
  populateDeletedAtValue(newContent);

  const updatedContent = await runUpdateQuery(newContent, options);

  if (!options.skipBalanceOperations) {
    await creditOrDebitTabCoins(oldContent, updatedContent, {
      eventId: options.eventId,
      transaction: options.transaction,
    });
  }

  updatedContent.tabcoins = await balance.getTotal(
    {
      balanceType: 'content:tabcoin',
      recipientId: updatedContent.id,
    },
    {
      transaction: options.transaction,
    }
  );

  return updatedContent;

  async function runUpdateQuery(content, options = {}) {
    const query = {
      text: `
      WITH
        updated_content as (
          UPDATE contents SET
            parent_id = $2,
            slug = $3,
            title = $4,
            body = $5,
            status = $6,
            source_url = $7,
            published_at = $8,
            updated_at = (now() at time zone 'utc'),
            deleted_at = $9
          WHERE
            id = $1
          RETURNING *
        )
      SELECT
        updated_content.id,
        updated_content.owner_id,
        updated_content.parent_id,
        updated_content.slug,
        updated_content.title,
        updated_content.body,
        updated_content.status,
        updated_content.source_url,
        updated_content.created_at,
        updated_content.updated_at,
        updated_content.published_at,
        updated_content.deleted_at,
        users.username as owner_username
      FROM
        updated_content
      INNER JOIN
        users ON updated_content.owner_id = users.id
      ;`,
      values: [
        content.id,
        content.parent_id,
        content.slug,
        content.title,
        content.body,
        content.status,
        content.source_url,
        content.published_at,
        content.deleted_at,
      ],
    };
    try {
      const results = await database.query(query, { transaction: options.transaction });
      return results.rows[0];
    } catch (error) {
      throw parseQueryErrorToCustomError(error);
    }
  }
}

function validateUpdateSchema(content) {
  const cleanValues = validator(content, {
    slug: 'optional',
    title: 'optional',
    body: 'optional',
    status: 'optional',
    source_url: 'optional',
  });

  return cleanValues;
}

function checkForParentIdRecursion(content) {
  if (content.parent_id === content.id) {
    throw new ValidationError({
      message: `"parent_id" não deve apontar para o próprio conteúdo.`,
      action: `Utilize um "parent_id" diferente do "id" do mesmo conteúdo.`,
      stack: new Error().stack,
      errorLocationCode: 'MODEL:CONTENT:CHECK_FOR_PARENT_ID_RECURSION:RECURSION_FOUND',
      statusCode: 400,
      key: 'parent_id',
    });
  }
}

function populateDeletedAtValue(contentObject) {
  if (!contentObject.deleted_at && contentObject.status === 'deleted') {
    contentObject.deleted_at = new Date();
  }
}

function throwIfContentIsAlreadyDeleted(oldContent) {
  if (oldContent.status === 'deleted') {
    throw new ValidationError({
      message: `Não é possível alterar informações de um conteúdo já deletado.`,
      stack: new Error().stack,
      errorLocationCode: 'MODEL:CONTENT:CHECK_STATUS_CHANGE:STATUS_ALREADY_DELETED',
      statusCode: 400,
      key: 'status',
    });
  }
}

function throwIfContentPublishedIsChangedToDraft(oldContent, newContent) {
  if (oldContent.status === 'published' && newContent.status === 'draft') {
    throw new ValidationError({
      message: `Não é possível alterar para rascunho um conteúdo já publicado.`,
      stack: new Error().stack,
      errorLocationCode: 'MODEL:CONTENT:CHECK_STATUS_CHANGE:STATUS_ALREADY_PUBLISHED',
      statusCode: 400,
      key: 'status',
    });
  }
}

async function findTree(options) {
  const findTreeStartTime = performance.now();
  const { per_page, strategy, published_before, published_after } = validateOptionsSchema(options);
  const { parent_id, id, owner_id, owner_username, slug } = validateWhereSchema(options?.where);
  const values = [per_page, parent_id, id, owner_id, owner_username, slug, published_before, published_after].filter(
    (value) => value !== undefined
  );

  const queryStartTime = performance.now();
  const flatList = await recursiveDatabaseLookup();
  const queryEndTime = performance.now();
  const tree = flatListToTree(flatList);
  const findTreeEndTime = performance.now();
  console.log({
    findTreeTime: findTreeEndTime - findTreeStartTime,
    queryTime: queryEndTime - queryStartTime,
    flatListToTreeTime: findTreeEndTime - queryEndTime,
    per_page,
    strategy,
    published_before,
    published_after,
    parent_id,
    id,
    owner_id,
    owner_username,
    slug,
  });
  return tree;

  async function recursiveDatabaseLookup() {
    const sortDirection =
      (strategy !== 'old' && published_after) || (strategy === 'old' && !published_before) ? 'ASC' : 'DESC';
    const query = {
      text: `
      WITH RECURSIVE tree AS (
        SELECT
          id,
          (CASE WHEN parent_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[parent_id] END) AS path,
          ARRAY[published_at] AS sort_array
        FROM contents
        WHERE
          ${parent_id ? 'contents.parent_id = $2 AND' : ''}
          ${id ? 'contents.id = $2 AND' : ''}
          ${owner_username && !owner_id ? `${whereOwnerUsername('$2')} AND` : ''}
          ${owner_id ? `contents.owner_id = $2 AND` : ''}
          ${slug ? 'contents.slug = $3 AND' : ''}
          status = 'published'
      UNION ALL 
        SELECT
          contents.id,
          path || contents.parent_id,
          sort_array || contents.published_at AS sort_array
        FROM contents
        INNER JOIN tree ON contents.parent_id = tree.id
        WHERE contents.status = 'published'
      ),

      paginated_tree AS (
        SELECT
          tree.*,
          (SELECT COUNT(*) FROM tree t 
          WHERE tree.id = ANY(t.path)
          ) AS children_deep_count
        FROM tree
        WHERE
          ${published_before ? 'tree.sort_array[1] < $3 AND' : ''}
          ${published_after ? 'tree.sort_array[1] > $3 AND' : ''}
          array_length(tree.sort_array, 1) < 5
        ORDER BY
          tree.sort_array[1] ${sortDirection},
          tree.sort_array[2] ${sortDirection} NULLS FIRST,
          tree.sort_array[3] ${sortDirection} NULLS FIRST,
          tree.sort_array[4] ${sortDirection} NULLS FIRST
        LIMIT $1
      )

      SELECT
        contents.*,
        paginated_tree.children_deep_count,
        users.username as owner_username,
        get_current_balance('content:tabcoin', contents.id) as tabcoins
      FROM paginated_tree
      INNER JOIN
        contents ON contents.id = paginated_tree.id
      INNER JOIN
        users ON contents.owner_id = users.id
      ;`,
      values: values,
    };
    const results = await database.query(query);
    return results.rows;
  }

  function validateOptionsSchema(options) {
    return validator(options, {
      per_page: 'optional',
      published_before: 'optional',
      published_after: 'optional',
      strategy: 'optional',
    });
  }

  function validateWhereSchema(where) {
    let options = {};

    if (where.parent_id) {
      options.parent_id = 'required';
    } else if (where.id) {
      options.id = 'required';
    } else if (where.owner_id) {
      options.owner_id = 'required';
      options.slug = 'required';
    } else if (where.owner_username) {
      options.owner_username = 'required';
      options.slug = 'required';
    } else
      throw new ValidationError({
        message: `Você precisa fornecer um "parent_id", "id" ou a combinação do "slug" com "owner_id" ou "owner_username" para buscar uma árvore de conteúdo.`,
        action: `Verifique se forneceu os dados corretos.`,
        stack: new Error().stack,
        errorLocationCode: 'MODEL:CONTENT:CHECK_STATUS_CHANGE:STATUS_ALREADY_PUBLISHED',
        statusCode: 400,
        key: 'status',
      });

    const cleanValues = validator(where, options);

    return cleanValues;
  }

  function flatListToTree(list) {
    const tree = { children: [] };
    const table = {};

    list.forEach((row) => {
      table[row.id] = row;
      table[row.id].children = [];
    });

    list.forEach((row) => {
      if (table[row.parent_id]) {
        table[row.parent_id].children.push(row);
      } else {
        tree.children.push(row);
      }
    });

    sortRecursively(tree);

    return tree.children;

    function sortRecursively(node) {
      if (node.children) {
        node.children = sortContentByStrategy(node.children, strategy);
        node.children.forEach((child) => {
          sortRecursively(child);
        });
      }
    }

    function sortContentByStrategy(contentList) {
      if (strategy === 'new') {
        return contentList.sort((first, second) => {
          return new Date(second.published_at) - new Date(first.published_at);
        });
      }
      if (strategy === 'old') {
        return contentList.sort((first, second) => {
          return new Date(first.published_at) - new Date(second.published_at);
        });
      }
      return rankContentListByRelevance(contentList);
    }
  }
}

function whereOwnerUsername($n) {
  return `
    contents.owner_id = (
        SELECT
          id
        FROM
          users
        WHERE
          LOWER(username) = LOWER(${$n})
        LIMIT
          1
    )
  `;
}

function rankContentListByRelevance(contentList) {
  const rankedContentList = contentList.map(injectScoreProperty).sort(sortByScore);

  return rankedContentList;

  function injectScoreProperty(contentObject) {
    return {
      ...contentObject,
      score: getContentScore(contentObject),
    };
  }

  function sortByScore(first, second) {
    return second.score - first.score;
  }
}

// Inspired by:
// https://medium.com/hacking-and-gonzo/how-hacker-news-ranking-algorithm-works-1d9b0cf2c08d
// https://medium.com/hacking-and-gonzo/how-reddit-ranking-algorithms-work-ef111e33d0d9
const ageBaseInMilliseconds = 1000 * 60 * 60 * 6; // 6 hours
const boostPeriodInMilliseconds = 1000 * 60 * 10; // 10 minutes
const offset = 0.5;

function getContentScore(contentObject) {
  const tabcoins = contentObject.tabcoins;
  const ageInMilliseconds = Date.now() - new Date(contentObject.published_at);
  const initialBoost = ageInMilliseconds < boostPeriodInMilliseconds ? 3 : 1;
  const gravity = Math.exp(-ageInMilliseconds / ageBaseInMilliseconds);
  const score = (tabcoins - offset) * initialBoost;
  const finalScore = tabcoins > 0 ? score * (1 + gravity) : score * (1 - gravity);
  return finalScore;
}

async function findRootContent(values, options = {}) {
  values.where = validateWhereSchema(values?.where);
  const rootContentFound = await recursiveDatabaseLookup(values, options);
  return rootContentFound;

  function validateWhereSchema(where) {
    const cleanValues = validator(where, {
      id: 'required',
    });

    return cleanValues;
  }

  async function recursiveDatabaseLookup(values, options = {}) {
    const query = {
      text: `
      WITH RECURSIVE child_to_root_tree AS (
        SELECT
          *
        FROM
          contents
        WHERE
          id = $1
      UNION ALL
        SELECT
          contents.*
        FROM
          contents
        JOIN
          child_to_root_tree
        ON
          contents.id = child_to_root_tree.parent_id
      )
      SELECT
        child_to_root_tree.*,
        users.username as owner_username,
        get_current_balance('content:tabcoin', child_to_root_tree.id) as tabcoins,

        -- Originally this query returned the root content object to the server and
        -- afterward made an additional roundtrip to the database using the
        -- findChildrenCount() method to get the children count. Now we perform a
        -- subquery that is not performant but everything is embedded in one travel.
        -- https://github.com/filipedeschamps/tabnews.com.br/blob/3ab1c65fdfc03d079791d17fde693010ab4caa60/models/content.js#L1013
        (
          WITH RECURSIVE children AS (
            SELECT
                id,
                parent_id
            FROM
              contents
            WHERE
              contents.parent_id = child_to_root_tree.id AND
              contents.status = 'published'
            UNION ALL
              SELECT
                contents.id,
                contents.parent_id
              FROM
                contents
              INNER JOIN
                children ON contents.parent_id = children.id
              WHERE
                contents.status = 'published'
          )
          SELECT
            count(children.id)::integer
          FROM
            children
        ) as children_deep_count
      FROM
        child_to_root_tree
      INNER JOIN
        users ON child_to_root_tree.owner_id = users.id
      WHERE
        parent_id IS NULL;
      ;`,
      values: [values.where.id],
    };

    const results = await database.query(query, { transaction: options.transaction });
    return results.rows[0];
  }
}

async function find({
  parent_id,
  id,
  owner_id,
  owner_username,
  slug,
  with_parent,
  with_root,
  with_children,
  strategy,
  page,
  per_page,
  published_before,
  published_after,
}) {
  const options = {
    with_children,
    with_parent,
    with_root,
    strategy,
    page,
    per_page,
    published_before,
    published_after,
  };

  if (parent_id) return await findTree({ where: { parent_id }, ...options });

  if (id) return await findContent({ where: { id } }, options);

  if (owner_id && slug) return await findContent({ where: { owner_id, slug } }, options);

  if (owner_username && slug) return await findContent({ where: { owner_username, slug } }, options);

  if (slug)
    throw new ValidationError({
      message: `Você está tentando buscar um conteúdo pelo "slug", mas não informou o "owner_id" ou "owner_username".`,
      action: `Informe também o "owner_id" ou "owner_username" para buscar um conteúdo pelo "slug".`,
      stack: new Error().stack,
      error_location_code: 'MODEL:CONTENT:FIND:MISSING_OWNER_ID_OR_USERNAME',
    });

  if (options?.with_parent)
    throw new ValidationError({
      message: `"with_parent" não pode ser utilizado sem "id" ou "slug".`,
      action: `Informe dados de um conteúdo específico para obter o "parent".`,
      stack: new Error().stack,
      error_location_code: 'MODEL:CONTENT:FIND:MISSING_ID_OR_SLUG',
    });

  if (options?.with_root === false && options?.with_children === false)
    throw new ValidationError({
      message: `A busca precisa retornar conteúdos "root" (with_root) e/ou "child" (with_children).`,
      action: `Verifique se os dados foram digitados corretamente.`,
      stack: new Error().stack,
      error_location_code: 'MODEL:CONTENT:FIND:MISSING_ROOT_AND_CHILDREN_FLAG',
    });

  return await findWithStrategy({
    where: {
      parent_id: with_children || with_root === false ? undefined : null,
      $not_null: with_root === false ? ['parent_id'] : undefined,
      owner_id,
      owner_username,
      status: 'published',
    },
    attributes: { exclude: ['body'] },
    ...options,
  });

  async function findContent(query, options) {
    const content = options.with_children
      ? await findTree({ ...query, ...options }).then((trees) => trees[0])
      : await findOne({
          where: { ...query.where, status: 'published' },
        });

    if (!content)
      throw new NotFoundError({
        message: `O conteúdo informado não foi encontrado no sistema.`,
        action: 'Verifique se os dados foram digitados corretamente.',
        stack: new Error().stack,
        errorLocationCode: 'MODEL:CONTENT:FIND:CONTENT_NOT_FOUND',
      });

    if (options?.with_parent && content.parent_id) {
      content.parent = await findOne({ where: { id: content.parent_id } });
    }

    if (options?.with_root && content.parent_id) {
      content.root = content.parent?.parent_id
        ? await findRootContent({ where: { id: content.parent.parent_id } })
        : content.parent || (await findRootContent({ where: { id: content.parent_id } }));
    }

    return content;
  }
}

export default Object.freeze({
  find,
  findAll,
  findOne,
  findTree,
  findWithStrategy,
  findRootContent,
  create,
  update,
});

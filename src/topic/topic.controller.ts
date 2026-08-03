import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { TopicService } from './topic.service';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';
import { AddSubtopicDto } from './dto/add-subtopic.dto';
import { GetTopicDto } from './dto/get-topic.dto';
import {
  createTopicExample,
  updateTopicExample,
} from './swagger_examples/examples';

@ApiTags('Topic')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('topic')
export class TopicController {
  constructor(private readonly topicService: TopicService) {}

  @Post()
  @ApiOperation({ summary: 'Create a topic' })
  @ApiBody({
    type: CreateTopicDto,
    examples: {
      basicExample: {
        summary: 'Create a new topic',
        value: createTopicExample,
      },
    },
  })
  create(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Body() createTopicDto: CreateTopicDto,
  ) {
    return this.topicService.create(this.getOrgId(req), createTopicDto);
  }

  @Get()
  @ApiOperation({ summary: 'List topics' })
  findAll(@Req() req: Request & { user?: { orgId?: number | string } }) {
    return this.topicService.findAll(this.getOrgId(req));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single topic' })
  findOne(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
  ) {
    return this.topicService.findOne(this.getOrgId(req), +id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a topic' })
  @ApiBody({
    type: UpdateTopicDto,
    examples: {
      renameTopic: {
        summary: 'Update topic title/description',
        value: updateTopicExample,
      },
    },
  })
  update(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
    @Body() updateTopicDto: UpdateTopicDto,
  ) {
    return this.topicService.update(this.getOrgId(req), +id, updateTopicDto);
  }

  @Post(':id/subtopics')
  @ApiOperation({ summary: 'Add a subtopic to an existing topic' })
  @ApiBody({
    type: AddSubtopicDto,
    examples: {
      addSubtopic: {
        summary: 'Add one subtopic',
        value: {
          subtopic: 'Investment Planning',
        },
      },
    },
  })
  addSubtopic(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
    @Body() addSubtopicDto: AddSubtopicDto,
  ) {
    return this.topicService.addSubtopic(
      this.getOrgId(req),
      +id,
      addSubtopicDto,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a topic' })
  remove(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Param('id') id: string,
  ) {
    return this.topicService.remove(this.getOrgId(req), +id);
  }

  private getOrgId(req: Request & { user?: { orgId?: number | string } }): string {
    return req.user?.orgId != null ? String(req.user.orgId) : '';
  }

  @Post('resolve-tags-from-chapter-ids')
  @ApiOperation({ summary: 'Resolve tags from chapter IDs' })
  @ApiBody({
    description: 'Provide chapter IDs to resolve associated tags',
    type: GetTopicDto,
    examples: {
      resolveTagsFromChapterIds: {
        summary: 'Resolve tags from chapter IDs',
        value: {
          chapterIds: [6157, 6158, 6159],
          bootcampId: 873,
          moduleId: 806,
        },
      },
    },
  })
  resolveTagsFromChapterIds(
    @Req() req: Request & { user?: { orgId?: number | string } },
    @Body() body: GetTopicDto,
  ) {
    return this.topicService.resolveTagsFromChapterIds(
      this.getOrgId(req),
      body,
      req.headers.authorization,
    );
  }
}

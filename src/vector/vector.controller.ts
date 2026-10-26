import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VectorService } from './vector.service';
import { UpsertVectorsDto, EnsureCollectionDto } from './dto/create-vector.dto';
import { UpdateVectorDto } from './dto/update-vector.dto';
import { SearchVectorsDto, DeleteVectorsDto } from './dto/search-vector.dto';
import { VECTOR_STORE } from './constants';
import type { IVectorStore } from './interfaces/vector-store.interface';

@ApiTags('Vector')
@Controller('vector')
export class VectorController {
  constructor(
    private readonly vectorService: VectorService,
    // Injected by token, not by concrete class: the store is chosen by the
    // VECTOR_DB factory in VectorModule and the classes are not providers, so
    // naming one here both breaks DI at boot and bypasses the switch.
    @Inject(VECTOR_STORE) private readonly vectorStore: IVectorStore,
  ) {}

  @Post('collection')
  @ApiOperation({ summary: 'Ensure a vector collection exists' })
  @ApiBody({
    type: EnsureCollectionDto,
    examples: {
      default: {
        summary: 'Ensure QUESTIONS collection for embeddings',
        value: {
          collectionName: 'QUESTIONS',
          vectorSize: 1536,
        },
      },
    },
  })
  ensureCollection(@Body() dto: EnsureCollectionDto) {
    return this.vectorStore.ensureCollection(
      dto.collectionName,
      dto.vectorSize,
    );
  }

  @Post('upsert')
  upsert(@Body() dto: UpsertVectorsDto) {
    return this.vectorService.upsert(dto);
  }

  @Post('search')
  search(@Body() dto: SearchVectorsDto) {
    return this.vectorService.search(dto);
  }

  @Post('delete')
  delete(@Body() dto: DeleteVectorsDto) {
    return this.vectorService.delete(dto.collectionName, dto.ids);
  }

  @Post()
  create(@Body() createVectorDto: UpsertVectorsDto) {
    return this.vectorService.upsert(createVectorDto);
  }

  @Get()
  findAll() {
    return { message: 'Use POST /vector/search with body { collectionName, queryVector, limit? }' };
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { message: `Vector lookup by id not implemented; use search. id=${id}` };
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() _updateVectorDto: UpdateVectorDto) {
    return { message: `Update single vector not implemented. id=${id}` };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.vectorService.delete('default', [id]);
  }
}

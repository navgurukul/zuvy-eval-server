import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { VectorService } from './vector.service';
import { UpsertVectorsDto, EnsureCollectionDto } from './dto/create-vector.dto';
import { UpdateVectorDto } from './dto/update-vector.dto';
import { SearchVectorsDto, DeleteVectorsDto } from './dto/search-vector.dto';

@Controller('vector')
export class VectorController {
  constructor(private readonly vectorService: VectorService) {}

  @Post('collection')
  ensureCollection(@Body() dto: EnsureCollectionDto) {
    return this.vectorService.ensureCollection(
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

"""Administrative department tree API."""

from __future__ import annotations

import asyncio
from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StringConstraints

from octop.api.deps import get_server, require_admin
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter(dependencies=[Depends(require_admin())])


class DepartmentNameBody(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class CreateDepartmentBody(DepartmentNameBody):
    parent_id: str | None = Field(
        default=None, min_length=1, max_length=64, description="Omit for a root organization."
    )


class DepartmentResponse(BaseModel):
    department_id: str
    parent_id: str | None = Field(description="Public ID of the parent, or null for a root.")
    name: str


ProfileText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]


class DepartmentProfileDetails(BaseModel):
    full_name: ProfileText | None = None
    enabled: bool = True
    effective_date: date | None = None
    code_path: ProfileText | None = Field(
        default=None, description="Path from the source organization system."
    )
    province_company_code: ProfileText | None = None
    province_company_name: ProfileText | None = None
    city_company_code: ProfileText | None = None
    city_company_name: ProfileText | None = None
    area_code: ProfileText | None = None
    area_name: ProfileText | None = None
    site_code: ProfileText | None = None
    site_name: ProfileText | None = None
    hos_code: ProfileText | None = None
    erp_code: ProfileText | None = None
    site_type: ProfileText | None = None
    operating_status: ProfileText | None = None
    source_site_status: ProfileText | None = None
    virtual_site: bool | None = None
    business_type_code: ProfileText | None = None
    management_type_code: ProfileText | None = None
    service_items: ProfileText | None = None
    administrative_region: ProfileText | None = None
    address: ProfileText | None = None
    contact_name: ProfileText | None = None
    contact_phone: ProfileText | None = None
    contact_email: ProfileText | None = None


class DepartmentProfileBody(DepartmentNameBody):
    sort_order: int | None = Field(default=None, ge=0, le=2147483647)
    details: DepartmentProfileDetails


class DepartmentProfileResponse(DepartmentResponse):
    sort_order: int | None
    details: DepartmentProfileDetails
    updated_at: datetime | None = Field(description="Last profile save, in UTC.")


@router.get("", response_model=list[DepartmentResponse], summary="List organization departments")
async def list_departments(server: Any = Depends(get_server)) -> Any:
    return await asyncio.get_running_loop().run_in_executor(
        None, server.services.repos.department_repo.list_all
    )


@router.post(
    "",
    status_code=201,
    response_model=DepartmentResponse,
    summary="Create an organization or department",
)
async def create_department(body: CreateDepartmentBody, server: Any = Depends(get_server)) -> Any:
    row = await asyncio.get_running_loop().run_in_executor(
        None, server.services.repos.department_repo.create, body.name, body.parent_id
    )
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, "parent department not found")
    return row


@router.patch("/{department_id}", response_model=DepartmentResponse, summary="Rename a department")
async def rename_department(
    department_id: str, body: DepartmentNameBody, server: Any = Depends(get_server)
) -> Any:
    row = await asyncio.get_running_loop().run_in_executor(
        None, server.services.repos.department_repo.rename, department_id, body.name
    )
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, "department not found")
    return row


@router.get("/{department_id}/profile", summary="Get a department profile")
async def get_department_profile(
    department_id: str, server: Any = Depends(get_server)
) -> DepartmentProfileResponse:
    result = await asyncio.get_running_loop().run_in_executor(
        None, server.services.repos.department_repo.get_profile, department_id
    )
    if result is None:
        raise OctopError(ErrorCode.NOT_FOUND, "department not found")
    row, profile = result
    response = DepartmentResponse.model_validate(row, from_attributes=True)
    return DepartmentProfileResponse(
        **response.model_dump(),
        sort_order=profile.sort_order,
        details=DepartmentProfileDetails.model_validate_json(profile.details_json),
        updated_at=datetime.fromisoformat(profile.updated_at) if profile.updated_at else None,
    )


@router.put("/{department_id}/profile", summary="Save a department profile")
async def save_department_profile(
    department_id: str, body: DepartmentProfileBody, server: Any = Depends(get_server)
) -> DepartmentProfileResponse:
    result = await asyncio.get_running_loop().run_in_executor(
        None,
        server.services.repos.department_repo.save_profile,
        department_id,
        body.name,
        body.sort_order,
        body.details.model_dump_json(exclude_none=True),
    )
    if result is None:
        raise OctopError(ErrorCode.NOT_FOUND, "department not found")
    row, profile = result
    response = DepartmentResponse.model_validate(row, from_attributes=True)
    return DepartmentProfileResponse(
        **response.model_dump(),
        sort_order=profile.sort_order,
        details=body.details,
        updated_at=datetime.fromisoformat(profile.updated_at) if profile.updated_at else None,
    )


@router.delete("/{department_id}", status_code=204, summary="Delete a department without children")
async def delete_department(department_id: str, server: Any = Depends(get_server)) -> Response:
    result = await asyncio.get_running_loop().run_in_executor(
        None, server.services.repos.department_repo.delete, department_id
    )
    if result == "missing":
        raise OctopError(ErrorCode.NOT_FOUND, "department not found")
    if result == "has_children":
        raise OctopError(ErrorCode.DEPARTMENT_HAS_CHILDREN, "department has children")
    return Response(status_code=204)
